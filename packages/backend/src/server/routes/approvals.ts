import { ApprovalStatus, ErrorCode, fail, type Approval } from '@datasentry/core'
import type { FastifyInstance } from 'fastify'
import type { AuthUser } from '../../auth/service.ts'
import type { AppContext } from '../../context.ts'
import {
  approvalCategoryOf,
  evaluateApprovalAuthority,
  type AuthorityVerdict,
} from '../../harness/approval-authority.ts'
import { requireUser } from '../auth-guard.ts'

/** 当前身份能不能批这条。列表用它把按钮置灰，决定接口用它真正拦截。 */
function authorityFor(ctx: AppContext, user: AuthUser, approval: Approval): AuthorityVerdict {
  const session = ctx.sessions.require(approval.sessionId)
  const workspace = ctx.loadWorkspace(session.workspaceId)

  return evaluateApprovalAuthority({
    category: approvalCategoryOf(approval.kind),
    policy: workspace.approvalPolicy,
    segregationOfDuties: workspace.segregationOfDuties,
    sessionCreatedBy: session.createdBy,
    actor: { userId: user.id, roles: user.approverRoles },
  })
}

function authorityPayload(verdict: AuthorityVerdict) {
  return verdict.ok
    ? { allowed: true, code: null, reason: null, requiredRoles: [] as string[] }
    : {
        allowed: false,
        code: verdict.code as string,
        reason: verdict.reason,
        requiredRoles: verdict.requiredRoles,
      }
}

/** 审批类接口：待办队列、决定、恢复。 */
export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * 待审批队列 —— 审批人看的就是这个列表。
   *
   * 先扫一遍超期未决的记录，避免「过期了还挂在待办里」这种让人白点一次的情况。
   */
  app.get('/approvals', async (request) => {
    const user = requireUser(request)
    ctx.approvals.expireOverdue()
    const { workspace, status } = request.query as { workspace?: string; status?: string }
    if (status && status !== 'pending') {
      fail(ErrorCode.APPROVAL_INVALID, `当前只支持查询 status=pending，收到 "${status}"`)
    }
    if (workspace !== undefined && !ctx.auth.canAccessWorkspace(user, workspace)) {
      fail(ErrorCode.FORBIDDEN, `当前身份没有 ${workspace} 的访问权限`, { workspace })
    }

    const scope = ctx.auth.workspaceScopeOf(user)
    return ctx.approvals
      .listPending(workspace)
      .filter((approval) => scope === null || scope.includes(approval.workspaceId))
      .map((approval) =>
        serializeApproval(approval, authorityPayload(authorityFor(ctx, user, approval))),
      )
  })

  app.get('/sessions/:id/approvals', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    ctx.sessions.require(id)
    ctx.approvals.expireOverdue()
    return ctx.approvals.listBySession(id).map((approval) =>
      serializeApproval(
        approval,
        approval.status === ApprovalStatus.PENDING
          ? authorityPayload(authorityFor(ctx, user, approval))
          : null,
      ),
    )
  })

  /**
   * 记录审批决定。
   *
   * 只记录，不执行。执行是单独一步（`POST /sessions/:id/resume` 或
   * `POST /approvals/:id/confirm`）——批准和执行往往不是同一个人、也不是同一时刻，
   * 把它们合成一个请求会让「谁批准了」和「谁触发了执行」分不清。
   */
  app.post('/approvals/:id/decide', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as {
      decision?: string
      reason?: string
    }

    if (body.decision !== 'granted' && body.decision !== 'denied') {
      fail(ErrorCode.APPROVAL_INVALID, 'decision 必须是 "granted" 或 "denied"')
    }

    // 先判「这个人有没有资格批」，再记录决定。
    const verdict = authorityFor(ctx, user, ctx.approvals.require(id))
    if (!verdict.ok) {
      fail(verdict.code, verdict.reason, { approvalId: id, requiredRoles: verdict.requiredRoles })
    }

    const decided = ctx.decideApproval(id, {
      decision: body.decision,
      /*
       * 审批人就是登录身份。
       *
       * 这一步授权的是「Agent 能不能执行这个工具」，不是签一个字——
       * 留名必须由登录保证，不能接受请求体里自己报的名字，
       * 否则审批记录可以被任何人写成任何人。
       */
      approver: user.displayName || user.username,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
    })

    const session = ctx.sessions.require(decided.sessionId)
    return {
      approval: serializeApproval(decided, null),
      session: { id: session.id, state: session.state, errorCode: session.errorCode },
    }
  })

  /**
   * 恢复被审批打断的任务。
   *
   * 这条路由的存在本身就是一条设计声明：批准不等于继续跑。
   * 恢复时会重放**原 ToolCall 及其原参数**，并重新核对审批绑定。
   */
  app.post('/sessions/:id/resume', async (request) => {
    const { id } = request.params as { id: string }
    const outcome = await ctx.resumeSession(id)
    return {
      sessionId: outcome.sessionId,
      state: outcome.state,
      resumed: outcome.resumed,
      errorCode: outcome.errorCode,
      errorMessage: outcome.errorMessage,
      steps: outcome.steps,
      approvalId: outcome.approvalId,
      reportId: outcome.reportId,
      draftVersion: outcome.draftVersion,
      artifactPath: outcome.artifactPath,
    }
  })
}

export function serializeApproval(
  approval: ReturnType<AppContext['approvals']['require']>,
  authority: ReturnType<typeof authorityPayload> | null,
) {
  return {
    id: approval.id,
    kind: approval.kind,
    sessionId: approval.sessionId,
    workspaceId: approval.workspaceId,
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    toolVersion: approval.toolVersion,
    /** 参数摘要：审批绑定的核心，参数一变就失效。 */
    paramsHash: approval.paramsHash,
    draftVersion: approval.draftVersion,
    recipientsHash: approval.recipientsHash,
    status: approval.status,
    approver: approval.approver,
    reason: approval.reason,
    expiresAt: approval.expiresAt,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
    /** 当前身份能不能批；非待审批状态为 null。 */
    authority,
  }
}
