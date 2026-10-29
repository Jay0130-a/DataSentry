import { createSessionInputSchema, ErrorCode, fail } from '@datasentry/core'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.ts'
import { requireUser } from '../auth-guard.ts'

/** 任务类接口：发起、执行、查询状态与事件轨迹。 */
export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/sessions', async (request, reply) => {
    const user = requireUser(request)
    const input = createSessionInputSchema.parse(request.body ?? {})

    // 发起任务等于在这个 Workspace 里新建一份数据，必须先是它的成员。
    if (!ctx.auth.canAccessWorkspace(user, input.workspace)) {
      fail(ErrorCode.FORBIDDEN, `当前身份没有 ${input.workspace} 的访问权限`, {
        workspace: input.workspace,
      })
    }

    const session = ctx.createSession(input, { userId: user.id })
    return reply.code(201).send(serializeSession(session, ctx.auth.displayNameOf(session.createdBy)))
  })

  app.get('/sessions', async (request) => {
    const user = requireUser(request)
    const { workspace } = request.query as { workspace?: string }

    if (workspace !== undefined && !ctx.auth.canAccessWorkspace(user, workspace)) {
      fail(ErrorCode.FORBIDDEN, `当前身份没有 ${workspace} 的访问权限`, { workspace })
    }

    const sessions = ctx.sessions.listScoped(ctx.auth.workspaceScopeOf(user), workspace)
    const names = ctx.auth.displayNamesFor(sessions.map((session) => session.createdBy))
    return sessions.map((session) =>
      serializeSession(session, session.createdBy ? (names.get(session.createdBy) ?? null) : null),
    )
  })

  app.get('/sessions/:id', async (request) => {
    const { id } = request.params as { id: string }
    const session = ctx.sessions.require(id)
    return {
      ...serializeSession(session, ctx.auth.displayNameOf(session.createdBy)),
      checkpoints: ctx.checkpoints.list(id),
      toolCalls: ctx.toolCalls.listBySession(id).map((call) => ({
        id: call.id,
        toolName: call.toolName,
        status: call.status,
        paramsHash: call.paramsHash,
        denyCode: call.denyCode,
        createdAt: call.createdAt,
      })),
    }
  })

  /**
   * 执行任务。
   *
   * M1 是同步执行并直接返回结果——没有审批等待，也就没有「先返回再回调」的必要。
   * M2 出现 WAITING_APPROVAL 之后，这里会改成立即返回 `202 + sessionId`，
   * 由审批事件驱动后续推进。
   */
  app.post('/sessions/:id/run', async (request) => {
    const { id } = request.params as { id: string }
    const outcome = await ctx.runSession(id)
    const report = ctx.reports.bySession(id)
    return {
      sessionId: outcome.sessionId,
      state: outcome.state,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
      steps: outcome.steps,
      stoppedAtIndex: outcome.stoppedAtIndex,
      stoppedAtTool: outcome.stoppedAtTool,
      report: report
        ? {
            reportId: report.id,
            draftVersion: report.draftVersion,
            status: report.status,
            artifactPath: report.artifactPath,
            metrics: report.metrics,
            conflicts: report.conflicts,
          }
        : null,
      results: outcome.results.map((result) => ({
        resultId: result.resultId,
        sourceSlug: result.sourceRef.slug,
        tool: result.sourceRef.tool,
        dataVersion: result.sourceRef.dataVersion,
        completeness: result.completeness,
        rowCount: result.meta.rowCount,
      })),
    }
  })

  /** 事件轨迹。`format=jsonl` 返回原始行，便于与文件比对。 */
  app.get('/sessions/:id/events', async (request) => {
    const { id } = request.params as { id: string }
    ctx.sessions.require(id)
    return { events: ctx.events.list(id) }
  })

  app.get('/sessions/:id/events.jsonl', async (request, reply) => {
    const { id } = request.params as { id: string }
    ctx.sessions.require(id)
    const events = ctx.events.readJsonl(id)
    return reply.type('application/x-ndjson').send(events.map((e) => JSON.stringify(e)).join('\n'))
  })

  app.get('/sessions/:id/report', async (request, reply) => {
    const { id } = request.params as { id: string }
    ctx.sessions.require(id)
    const report = ctx.reports.bySession(id)
    if (!report) {
      return reply.code(404).send({
        error: { code: 'REPORT_NOT_FOUND', message: `Session ${id} 还没有产出报表` },
      })
    }
    return report
  })
}

function serializeSession(
  session: ReturnType<AppContext['sessions']['require']>,
  createdByName?: string | null,
) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    createdBy: session.createdBy,
    createdByName: createdByName ?? null,
    state: session.state,
    step: session.step,
    stateVersion: session.stateVersion,
    skillName: session.skillName,
    skillVersion: session.skillVersion,
    inputVersion: session.inputVersion,
    traceId: session.traceId,
    request: session.request,
    input: session.input,
    errorCode: session.errorCode,
    errorMessage: session.errorMessage,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}
