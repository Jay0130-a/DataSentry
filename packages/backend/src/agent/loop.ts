import {
  ApprovalStatus,
  DataSentryError,
  ErrorCode,
  EventType,
  fail,
  hashValue,
  isTerminal,
  newResultId,
  SessionState,
  validateWithJsonSchema,
  type DataPaths,
  type LoadedSkill,
  type Session,
  type ToolCall,
  type ToolResult,
} from '@datasentry/core'
import type { AgentBackend, AgentContext, AgentStepRecord, AgentToolCall } from './backend.ts'
import { formatGuideNote } from './prompt.ts'
import type { CredentialManager } from '../credentials/manager.ts'
import type { EventStore } from '../events/event-store.ts'
import type { GuideTracker } from '../harness/guide-tracker.ts'
import { evaluatePreToolUse } from '../harness/pretooluse.ts'
import {
  isAgentCallableTool,
  READ_SOURCE_GUIDE_TOOL,
  subjectSourceOf,
  type ToolRegistry,
} from '../harness/tool-registry.ts'
import type { ApprovalStore } from '../runtime/approval-store.ts'
import { DEFAULT_APPROVAL_TTL_MS } from '../runtime/approval-store.ts'
import type { CheckpointStore } from '../runtime/checkpoint.ts'
import type { SessionStore } from '../runtime/session-store.ts'
import type { ToolCallStore } from '../runtime/tool-call-store.ts'
import type { LoadedWorkspace } from '../workspace/loader.ts'
import { readToolResult, writeDraft, writeToolResult } from '../reports/draft.ts'
import { computeMetrics, metricInputsOf, requiredMetricsOf } from '../reports/metrics.ts'
import { validateReport } from '../reports/validate.ts'
import type { LoadedSource } from '../sources/loader.ts'
import { ToolExecutionError, type SourceTransport } from '../sources/transports/types.ts'
import type { RegisteredTool } from '../sources/builder.ts'

/** 单次任务的步骤上限。防止规划器打转时把几十个期间的数据都取一遍。 */
export const DEFAULT_MAX_STEPS = 40

export interface AgentRunnerDeps {
  paths: DataPaths
  credentials: CredentialManager
  sessions: SessionStore
  toolCalls: ToolCallStore
  checkpoints: CheckpointStore
  approvals: ApprovalStore
  events: EventStore
  guides: GuideTracker
  registry: ToolRegistry
  transports: Map<string, SourceTransport>
  loadWorkspace: (ref: string) => LoadedWorkspace
  loadSkill: (name: string) => LoadedSkill
  loadSource: (slug: string) => LoadedSource
  /** 规划器。M1 是确定性脚本规划器；换真实 LLM 时只换这一项。 */
  backend: AgentBackend
  saveReport: (report: ReturnType<typeof writeDraft>['report']) => void
  maxSteps?: number
  /** 审批有效期，毫秒。测试用它把「审批过期」变成可测的路径。 */
  approvalTtlMs?: number
}

export interface RunOutcome {
  sessionId: string
  state: Session['state']
  errorCode: string | null
  errorMessage: string | null
  /** 完成的工具调用步数（含被拒绝或被挂起的那一步）。 */
  steps: number
  /** 成功取到的结果，供回归脚本断言。 */
  results: ToolResult[]
  reportId: string | null
  draftVersion: string | null
  artifactPath: string | null
  /** 因拒绝/失败而中断时，停在历史中的第几步、哪个工具。 */
  stoppedAtIndex: number | null
  stoppedAtTool: string | null
  /** 停在审批上时，待处理的审批 ID。 */
  approvalId: string | null
  /** 本次是否从审批等待中恢复执行。 */
  resumed: boolean
}

interface RunState {
  session: Session
  workspace: LoadedWorkspace
  skill: LoadedSkill
  activeSourceSlugs: string[]
  history: AgentStepRecord[]
  results: ToolResult[]
}

type LoopResult =
  | { kind: 'finished' }
  | { kind: 'denied'; code: string; message: string; index: number; tool: string }
  | { kind: 'failed'; code: string; message: string; index: number; tool: string }
  | {
      kind: 'awaiting-approval'
      approvalId: string
      toolCallId: string
      index: number
      tool: string
    }

type CallOutcome =
  | { kind: 'succeeded'; record: AgentStepRecord; result: ToolResult | null }
  | { kind: 'denied'; record: AgentStepRecord; code: string }
  | { kind: 'failed'; record: AgentStepRecord; code: string; message: string }
  | { kind: 'awaiting-approval'; record: AgentStepRecord; approvalId: string; toolCallId: string }

interface OutcomePatch {
  reportId?: string | null
  draftVersion?: string | null
  artifactPath?: string | null
  stoppedAtIndex?: number | null
  stoppedAtTool?: string | null
  approvalId?: string | null
  resumed?: boolean
}

/** 从哪一段进入执行。恢复时用来跳过已经走完的部分。 */
type EntryPhase = 'init' | 'fetching' | 'computing'

interface DriveOptions {
  /** 本次是否由恢复触发。只影响事件里的标记，不改变流程。 */
  resumed?: boolean
  /** 默认 `init`：完整跑一遍（规划 → 取数 → 计算 → 草稿）。 */
  entry?: EntryPhase
  /** 恢复时重放的那条原调用。 */
  resumeCall?: ToolCall
}

/**
 * Agent Loop（PRD §5 的核心流程）。
 *
 * 四条不变量：
 *
 * 1. **先判定、再执行。** 工具调用在真正跑之前必须过 PreToolUse，无论允许、
 *    拒绝还是要求审批，都会落事件、落 tool_call 记录。被拒绝的调用同样留下审计痕迹——
 *    「谁试图越权取什么数据」比「谁成功取到了」更值得留。
 * 2. **状态转移只走 `transition`**，它内部走 `state_version` 条件更新。
 *    并发或残留的执行器不可能覆盖新状态。
 * 3. **恢复不重新规划。** 审批通过后重放的是库里那条原 ToolCall 及其原参数，
 *    参数摘要对不上就拒绝——这正是审批绑定要防的那件事。
 * 4. **已完成的步骤不重放。** 记忆由 `tool_call` 表与落盘结果重建，
 *    规划器据此从第一个未完成的步骤继续。
 */

/**
 * 恢复记忆时重建 guide 的返回文本。
 *
 * 内置工具的返回不落库，但它来自磁盘上确定的 guide 文件，
 * 重新读一遍即可——比把整段 guide 塞进 `tool_call` 表更干净。
 */
function guideNoteFrom(
  slug: unknown,
  loadSource: (slug: string) => LoadedSource,
): { note?: string } {
  if (typeof slug !== 'string' || slug.length === 0) return {}
  try {
    const source = loadSource(slug)
    return { note: formatGuideNote(slug, source.guideText) }
  } catch {
    return {}
  }
}

export class AgentRunner {
  private readonly maxSteps: number
  private readonly approvalTtlMs: number

  constructor(private readonly deps: AgentRunnerDeps) {
    this.maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
    this.approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
  }

  async run(sessionId: string): Promise<RunOutcome> {
    const existing = this.deps.sessions.require(sessionId)

    // 停在审批上的任务，再次执行就是「恢复」，而不是从头再跑一遍。
    if (existing.state === SessionState.WAITING_APPROVAL) {
      return this.resumeFromApproval(sessionId)
    }

    // 被中断（进程挂了、显式暂停）的任务，从最后一个检查点继续。
    if (existing.state === SessionState.PAUSED) {
      return this.resumeFromCheckpoint(sessionId)
    }

    if (isTerminal(existing.state)) {
      return this.bareOutcome(existing)
    }

    if (existing.state !== SessionState.INIT) {
      fail(
        ErrorCode.ILLEGAL_STATE_TRANSITION,
        `Session ${sessionId} 当前状态为 ${existing.state}，不能从头执行`,
        { sessionId, state: existing.state },
      )
    }

    return this.drive(this.buildState(existing))
  }

  /**
   * 从审批等待中恢复（PRD FR-04.3）。
   *
   * 恢复的过程刻意不含任何规划：
   * 1. 找到那条悬挂的 tool_call（已记录、未出结果）
   * 2. 取出挂在它上面的审批，按状态分流
   * 3. 通过则重建记忆、重放**原 ToolCall 及其原参数**
   *
   * 参数摘要在 PreToolUse 的 `approval-validity` 一项上被再次核对，
   * 所以即便库里的参数被人改过，也会以 `APPROVAL_PARAMS_DRIFT` 停下。
   */
  private async resumeFromApproval(sessionId: string): Promise<RunOutcome> {
    const { toolCalls, approvals, sessions } = this.deps
    const session = sessions.require(sessionId)
    const state = this.buildState(session)

    const suspended = toolCalls.pendingBySession(sessionId)
    if (suspended.length !== 1) {
      fail(
        ErrorCode.SESSION_NOT_FOUND,
        `Session ${sessionId} 处于 ${session.state}，但悬挂的工具调用有 ${suspended.length} 条（期望恰好 1 条）`,
        { sessionId, pending: suspended.map((c) => c.id) },
      )
    }
    const call = suspended[0]!

    const approval = approvals.byToolCall(call.id)
    if (!approval) {
      fail(ErrorCode.APPROVAL_INVALID, `工具调用 ${call.id} 上没有审批记录，无法恢复`, {
        toolCallId: call.id,
      })
    }

    // 仍未决：什么也不做，如实返回「还在等」。
    if (approval.status === ApprovalStatus.PENDING) {
      return this.buildOutcome(state, { approvalId: approval.id, resumed: false })
    }

    // 被否决 / 已过期 / 被吊销：任务停在 BLOCKED，等人工处理，而不是换个参数重试。
    if (approval.status !== ApprovalStatus.GRANTED) {
      state.session = this.transition(state, SessionState.BLOCKED, {
        errorCode:
          approval.status === ApprovalStatus.EXPIRED
            ? ErrorCode.APPROVAL_EXPIRED
            : ErrorCode.APPROVAL_DENIED,
        errorMessage:
          approval.reason ??
          `审批 ${approval.id} 状态为 ${approval.status}，任务已停止`,
      })
      return this.buildOutcome(state, { approvalId: approval.id, resumed: true })
    }

    // 发布确认不是「取数审批」：它的执行入口是 confirmPublish，那一步会重新核对
    // 文件字节、接收人与草稿版本。若在这里重放，会按取数循环的语义把整个报表
    // 再算一遍，会话被留在一个自相矛盾的状态上（报表已发布、会话却回到 READY）。
    if (approval.kind === 'publish') {
      fail(
        ErrorCode.PUBLISH_CONFIRMATION_PENDING,
        `审批 ${approval.id} 是发布确认，执行入口是 confirm-publish，不能通过恢复重放`,
        { sessionId, approvalId: approval.id },
      )
    }

    // 已批准：重建记忆，回到取数阶段继续。
    const rebuilt = this.rebuildMemory(sessionId)
    state.history = rebuilt.history
    state.results = rebuilt.results
    state.session = this.transition(state, SessionState.FETCHING)

    return this.drive(state, { entry: 'fetching', resumeCall: call, resumed: true })
  }

  /**
   * 从检查点继续（PRD FR-04.2）。
   *
   * 进程在取数途中挂掉时，Session 停在 PAUSED，最后一个检查点记录了当时走到哪一段。
   * 恢复就从那一段接着走——**已完成步骤不再重放**，记忆同样由 tool_call 表重建。
   *
   * 若最后停在计算之后，就直接从计算段重来：重算是幂等的，重取数不是。
   */
  private async resumeFromCheckpoint(sessionId: string): Promise<RunOutcome> {
    const { sessions, checkpoints } = this.deps
    const session = sessions.require(sessionId)
    const state = this.buildState(session)

    const rebuilt = this.rebuildMemory(sessionId)
    state.history = rebuilt.history
    state.results = rebuilt.results

    const lastCheckpoint = checkpoints.latest(sessionId)
    const interruptedAt = lastCheckpoint?.state ?? SessionState.FETCHING

    const entry: EntryPhase =
      interruptedAt === SessionState.COMPUTING ||
      interruptedAt === SessionState.VALIDATING ||
      interruptedAt === SessionState.READY
        ? 'computing'
        : 'fetching'

    state.session = this.transition(
      state,
      entry === 'computing' ? SessionState.COMPUTING : SessionState.FETCHING,
      { errorCode: null, errorMessage: null },
    )

    return this.drive(state, { entry, resumed: true })
  }

  private buildState(session: Session): RunState {
    const workspace = this.deps.loadWorkspace(session.workspaceId)
    const skill = this.deps.loadSkill(session.skillName)

    return {
      session,
      workspace,
      skill,
      // 预启用（PRD §5）：Skill 声明的 requiredSources 与 Workspace 边界的交集。
      activeSourceSlugs: skill.requiredSources.filter((slug) => workspace.sources.includes(slug)),
      history: [],
      results: [],
    }
  }

  /**
   * 从库和磁盘重建 Agent 的记忆。
   *
   * 内存里的取数结果在进程重启后就没有了，但 `tool_call.result_ref` 指向的
   * 落盘结果还在——而且那份才是当时真正喂给指标计算的东西。
   * 重建出的顺序由 `tool_call.step` 保证，不依赖时间戳。
   */
  private rebuildMemory(sessionId: string): {
    history: AgentStepRecord[]
    results: ToolResult[]
  } {
    const calls = this.deps.toolCalls
      .listBySession(sessionId)
      .filter((call) => call.status !== 'pending')

    const history: AgentStepRecord[] = []
    const results: ToolResult[] = []

    for (const call of calls) {
      const result = call.resultRef
        ? readToolResult(sessionId, call.resultRef, this.deps.paths)
        : undefined

      history.push({
        step: call.step,
        toolName: call.toolName,
        args: call.args,
        status:
          call.status === 'succeeded' ? 'succeeded' : call.status === 'denied' ? 'denied' : 'failed',
        ...(result ? { result } : {}),
        // 内置工具的返回文本不落库，但它来自磁盘上确定的 guide 文件，
        // 恢复时重新读一遍即可——比把它塞进 tool_call 表更干净。
        ...(call.status === 'succeeded' && call.toolName === READ_SOURCE_GUIDE_TOOL
          ? guideNoteFrom(call.args['sourceSlug'], this.deps.loadSource)
          : {}),
        ...(call.denyCode ? { errorCode: call.denyCode } : {}),
        ...(call.denyReason ? { errorMessage: call.denyReason } : {}),
      })
      if (result) results.push(result)
    }

    return { history, results }
  }

  private async drive(state: RunState, options: DriveOptions = {}): Promise<RunOutcome> {
    const { events } = this.deps
    const entry: EntryPhase = options.entry ?? 'init'
    const resumed = options.resumed ?? false

    if (entry === 'init') {
      // —— INIT → PLANNING ——
      state.session = this.transition(state, SessionState.PLANNING)
      events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.SkillLoaded,
        payload: {
          skill: state.skill.name,
          skillVersion: state.skill.version,
          sessionSkillVersion: state.session.skillVersion,
          versionMatches: state.skill.version === state.session.skillVersion,
          requiredSources: state.skill.requiredSources,
          stopRules: state.skill.stopRules,
        },
      })

      const notInWorkspace = state.skill.requiredSources.filter(
        (slug) => !state.workspace.sources.includes(slug),
      )
      for (const slug of state.activeSourceSlugs) {
        events.emit({
          sessionId: state.session.id,
          traceId: state.session.traceId,
          type: EventType.SourceActivated,
          payload: { sourceSlug: slug, reason: 'skill.requiredSources ∩ workspace.sources' },
        })
      }
      if (notInWorkspace.length > 0) {
        events.emit({
          sessionId: state.session.id,
          traceId: state.session.traceId,
          type: EventType.ValidationFailed,
          payload: {
            stage: 'planning',
            reason: 'Skill 依赖的 Source 不在当前 Workspace 边界内',
            sourceSlugs: notInWorkspace,
          },
        })
      }

      // —— PLANNING → FETCHING ——
      state.session = this.transition(state, SessionState.FETCHING)
    }

    // 计算段之后的流程对三种入口是共用的；只有取数段需要判断从哪进。
    if (entry !== 'computing') {
      const loop = await this.fetchLoop(state, options.resumeCall)

      if (loop.kind === 'awaiting-approval') {
        // 取数审批：停在 WAITING_APPROVAL，等人工决定。检查点记下审批引用，
        // 恢复时靠它找回原 ToolCall。
        state.session = this.transition(state, SessionState.WAITING_APPROVAL)
        this.saveCheckpoint(state, loop.toolCallId, null, loop.approvalId)
        return this.buildOutcome(state, {
          approvalId: loop.approvalId,
          stoppedAtIndex: loop.index,
          stoppedAtTool: loop.tool,
          resumed,
        })
      }

      if (loop.kind === 'denied') {
        state.session = this.transition(state, SessionState.BLOCKED, {
          errorCode: loop.code,
          errorMessage: loop.message,
        })
        return this.buildOutcome(state, {
          stoppedAtIndex: loop.index,
          stoppedAtTool: loop.tool,
          resumed,
        })
      }

      if (loop.kind === 'failed') {
        state.session = this.transition(state, SessionState.FAILED, {
          errorCode: loop.code,
          errorMessage: loop.message,
        })
        return this.buildOutcome(state, {
          stoppedAtIndex: loop.index,
          stoppedAtTool: loop.tool,
          resumed,
        })
      }
    }

    // —— FETCHING → COMPUTING ——
    state.session = this.transition(state, SessionState.COMPUTING)
    const computed = computeMetrics(state.results, metricInputsOf(state.workspace))
    for (const metric of computed.metrics) {
      events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.MetricComputed,
        payload: {
          metricKey: metric.key,
          label: metric.label,
          value: metric.value,
          unit: metric.unit,
          formula: metric.formula,
          completeness: metric.completeness,
          inputs: metric.inputs,
        },
      })
    }

    // —— COMPUTING → VALIDATING ——
    state.session = this.transition(state, SessionState.VALIDATING)
    const validation = validateReport({
      results: state.results,
      metrics: computed.metrics,
      conflicts: computed.conflicts,
      warnings: computed.warnings,
      required: requiredMetricsOf(state.workspace),
    })

    if (!validation.ok) {
      events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.ValidationFailed,
        payload: { failures: validation.failures, warnings: validation.warnings },
      })
      // 口径冲突是「需要人判断采用哪个口径」，不是「程序错了」——转人工而不是判失败。
      state.session =
        computed.conflicts.length > 0
          ? this.transition(state, SessionState.MANUAL_REVIEW, {
              errorCode: ErrorCode.VALIDATION_FAILED,
              errorMessage: validation.failures.join('；'),
            })
          : this.transition(state, SessionState.FAILED, {
              errorCode: ErrorCode.VALIDATION_FAILED,
              errorMessage: validation.failures.join('；'),
            })
      return this.buildOutcome(state, { resumed: resumed })
    }

    // —— VALIDATING → READY ——
    state.session = this.transition(state, SessionState.READY)

    const { artifact, report } = writeDraft(
      {
        sessionId: state.session.id,
        workspaceId: state.workspace.id,
        period: String(state.session.input['period'] ?? ''),
        currency: state.workspace.currency,
        ruleVersion: state.workspace.ruleVersion,
        metrics: computed.metrics,
        conflicts: computed.conflicts,
        results: state.results,
        warnings: validation.warnings,
      },
      this.deps.paths,
      this.deps.credentials,
    )

    this.deps.saveReport(report)
    events.emit({
      sessionId: state.session.id,
      traceId: state.session.traceId,
      type: EventType.ReportDrafted,
      payload: {
        reportId: report.id,
        draftVersion: report.draftVersion,
        artifactPath: report.artifactPath,
        metricCount: artifact.metrics.length,
        warningCount: artifact.warnings.length,
      },
    })
    events.emit({
      sessionId: state.session.id,
      traceId: state.session.traceId,
      type: EventType.SessionCompleted,
      payload: {
        state: state.session.state,
        steps: state.history.length,
        metrics: artifact.metrics.map((m) => ({ key: m.key, value: m.value })),
      },
    })

    return this.buildOutcome(state, {
      reportId: report.id,
      draftVersion: report.draftVersion,
      artifactPath: report.artifactPath,
      resumed: resumed,
    })
  }

  /** 取数循环：规划 → 判定 → 执行，直到规划器说完成、某一步被拦下，或需要审批。 */
  private async fetchLoop(state: RunState, resumeCall?: ToolCall): Promise<LoopResult> {
    const { registry, guides, events } = this.deps
    let pendingResume = resumeCall

    for (;;) {
      if (state.history.length >= this.maxSteps) {
        return {
          kind: 'failed',
          code: ErrorCode.TOOL_EXECUTION_FAILED,
          message: `超过单任务步骤上限 ${this.maxSteps}，疑似规划器打转`,
          index: state.history.length,
          tool: '(none)',
        }
      }

      let calls: AgentToolCall[]
      let rationale: string | undefined

      if (pendingResume) {
        // 恢复时不问规划器：重放的就是库里那条原调用。
        calls = [{ name: pendingResume.toolName, args: pendingResume.args }]
        rationale = '恢复原 ToolCall（不重新规划）'
        events.emit({
          sessionId: state.session.id,
          traceId: state.session.traceId,
          type: EventType.PlanningCompleted,
          payload: { resumed: true, toolCallId: pendingResume.id, tool: pendingResume.toolName },
        })
      } else {
        let action
        try {
          action = await this.deps.backend.nextAction(this.agentContext(state, registry, guides))
        } catch (err) {
          // 模型调用失败（网络、认证、拒答、截断）属于「这一步没走成」，
          // 不能让异常裸奔出去——那会把 Session 永远留在 FETCHING 里。
          const code =
            err instanceof DataSentryError ? err.code : ErrorCode.MODEL_CALL_FAILED
          return {
            kind: 'failed',
            code,
            message: err instanceof Error ? err.message : String(err),
            index: state.history.length,
            tool: '(planner)',
          }
        }
        if (action.type === 'finish') {
          events.emit({
            sessionId: state.session.id,
            traceId: state.session.traceId,
            type: EventType.PlanningCompleted,
            payload: { summary: action.summary, steps: state.history.length },
          })
          return { kind: 'finished' }
        }
        calls = action.calls
        rationale = action.rationale
      }

      for (const call of calls) {
        const outcome = pendingResume
          ? await this.runCall(state, call, pendingResume)
          : await this.executeCall(state, call, rationale)
        pendingResume = undefined

        switch (outcome.kind) {
          case 'succeeded':
            state.history.push(outcome.record)
            if (outcome.result) state.results.push(outcome.result)
            break
          case 'denied':
            state.history.push(outcome.record)
            return {
              kind: 'denied',
              code: outcome.code,
              message: outcome.record.errorMessage ?? outcome.code,
              index: state.history.length - 1,
              tool: call.name,
            }
          case 'failed':
            state.history.push(outcome.record)
            return {
              kind: 'failed',
              code: outcome.code,
              message: outcome.message,
              index: state.history.length - 1,
              tool: call.name,
            }
          case 'awaiting-approval':
            state.history.push(outcome.record)
            return {
              kind: 'awaiting-approval',
              approvalId: outcome.approvalId,
              toolCallId: outcome.toolCallId,
              index: state.history.length - 1,
              tool: call.name,
            }
        }
      }
    }
  }

  private agentContext(
    state: RunState,
    registry: ToolRegistry,
    guides: GuideTracker,
  ): AgentContext {
    return {
      sessionId: state.session.id,
      workspaceId: state.workspace.id,
      request: state.session.request,
      input: state.session.input,
      skill: {
        name: state.skill.name,
        description: state.skill.description,
        body: state.skill.body,
        requiredSources: state.skill.requiredSources,
        stopRules: state.skill.stopRules,
      },
      tools: registry.list().filter(isAgentCallableTool).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        paramsSchema: tool.paramsSchema,
        guideRead:
          tool.kind === 'builtin' || guides.hasRead(state.session.id, tool.sourceSlug),
      })),
      activeSourceSlugs: state.activeSourceSlugs,
      history: state.history,
    }
  }

  /** 新的一次调用：先落一条 pending 记录，再走统一的判定与执行。 */
  private async executeCall(
    state: RunState,
    call: AgentToolCall,
    rationale?: string,
  ): Promise<CallOutcome> {
    const tool = this.deps.registry.get(call.name)
    const record = this.deps.toolCalls.create({
      sessionId: state.session.id,
      step: state.session.step,
      toolName: call.name,
      sourceSlug: tool?.sourceSlug ?? 'unknown',
      paramsHash: hashValue(call.args),
      toolVersion: tool?.toolVersion ?? 'unregistered',
      args: call.args,
    })
    return this.runCall(state, call, record, rationale)
  }

  /** 统一的判定 + 执行路径，新调用与恢复重放共用。 */
  private async runCall(
    state: RunState,
    call: AgentToolCall,
    record: ToolCall,
    rationale?: string,
    options: { allowPublish?: boolean } = {},
  ): Promise<CallOutcome> {
    const { registry, events, toolCalls, guides, approvals } = this.deps
    const { session } = state

    const tool: RegisteredTool | undefined = registry.get(call.name)

    /*
     * 参数摘要**由参数现算**，并与记录里的那一份核对。
     *
     * 早先的实现直接相信记录里的 `params_hash` 字段，那是错的：审批绑定比对的是这个
     * 字段，而真正执行用的是 `args`。两者一旦不同步——有人改了参数却没改摘要——
     * 绑定就被整个绕过：审批批的是 A，执行的却是 B。
     * 摘要必须是参数的推导结果，不能是另一份可以独立改动的数据。
     */
    const paramsHash = hashValue(call.args)
    const tampered = paramsHash !== record.paramsHash

    const emit = (type: EventType, payload: Record<string, unknown>): void => {
      events.emit({ sessionId: session.id, traceId: session.traceId, type, payload })
    }

    emit(EventType.ToolCallRequested, {
      toolCallId: record.id,
      step: record.step,
      toolName: call.name,
      sourceSlug: tool?.sourceSlug ?? 'unknown',
      paramsHash,
      args: call.args,
      ...(rationale !== undefined ? { rationale } : {}),
    })

    // 记录自洽性检查：参数与摘要对不上，说明这条记录被改动过。
    // 它排在所有权限检查之前——不是「能不能调」，而是「这条记录还作不作数」。
    if (tampered) {
      const reason =
        `工具调用 ${record.id} 的参数与记录中的摘要不一致` +
        `（记录 ${record.paramsHash.slice(0, 12)}…，实算 ${paramsHash.slice(0, 12)}…），记录已被改动`
      toolCalls.finish(record.id, 'denied', {
        denyCode: ErrorCode.APPROVAL_PARAMS_DRIFT,
        denyReason: reason,
      })
      emit(EventType.ToolCallFailed, {
        toolCallId: record.id,
        toolName: call.name,
        status: 'denied',
        code: ErrorCode.APPROVAL_PARAMS_DRIFT,
        reason,
      })
      return {
        kind: 'denied',
        code: ErrorCode.APPROVAL_PARAMS_DRIFT,
        record: this.stepRecord(state, call, 'denied', {
          code: ErrorCode.APPROVAL_PARAMS_DRIFT,
          message: reason,
        }),
      }
    }

    const approval = approvals.byToolCall(record.id)

    const verdict = evaluatePreToolUse({
      toolName: call.name,
      args: call.args,
      tool,
      subjectSourceSlug: subjectSourceOf(tool, call.args),
      workspaceSourceSlugs: state.workspace.sources,
      activeSourceSlugs: state.activeSourceSlugs,
      guideRead: (slug) => guides.hasRead(session.id, slug),
      permissionMode: state.workspace.defaultPermissionMode,
      paramsHash,
      approval,
      ...(options.allowPublish === true ? { allowPublish: true } : {}),
    })

    emit(EventType.PermissionDecided, {
      toolCallId: record.id,
      toolName: call.name,
      effect: verdict.effect,
      code: verdict.code ?? null,
      reason: verdict.reason,
      checkedBy: verdict.checkedBy,
      approvalId: approval?.id ?? null,
    })

    // —— 需要审批：挂起，等人工 ——
    if (verdict.effect === 'ask') {
      const created = approvals.create({
        sessionId: session.id,
        workspaceId: state.workspace.id,
        toolCallId: record.id,
        toolName: call.name,
        toolVersion: tool?.toolVersion ?? 'unregistered',
        paramsHash,
        kind: 'tool-call',
        ttlMs: this.approvalTtlMs,
      })
      emit(EventType.ApprovalRequested, {
        approvalId: created.id,
        toolCallId: record.id,
        toolName: call.name,
        sourceSlug: tool?.sourceSlug ?? 'unknown',
        sensitivity: tool?.sensitivity ?? 'unknown',
        paramsHash,
        args: call.args,
        reason: verdict.reason,
        expiresAt: created.expiresAt,
      })
      return {
        kind: 'awaiting-approval',
        approvalId: created.id,
        toolCallId: record.id,
        record: this.stepRecord(state, call, 'succeeded', { step: record.step }),
      }
    }

    if (verdict.effect === 'deny') {
      const code = verdict.code ?? 'DENIED'
      toolCalls.finish(record.id, 'denied', { denyCode: code, denyReason: verdict.reason })
      emit(EventType.ToolCallFailed, {
        toolCallId: record.id,
        toolName: call.name,
        status: 'denied',
        code,
        reason: verdict.reason,
      })
      return {
        kind: 'denied',
        code,
        record: this.stepRecord(state, call, 'denied', { code, message: verdict.reason }),
      }
    }

    try {
      if (tool?.kind === 'builtin' && call.name === READ_SOURCE_GUIDE_TOOL) {
        return this.executeGuideRead(state, call, record.id, emit)
      }
      return await this.executeSourceCall(state, call, tool!, record.id, emit)
    } catch (err) {
      const code = err instanceof ToolExecutionError ? err.code : ErrorCode.TOOL_EXECUTION_FAILED
      const message = err instanceof Error ? err.message : String(err)
      toolCalls.finish(record.id, 'failed', { denyCode: code, denyReason: message })
      emit(EventType.ToolCallFailed, {
        toolCallId: record.id,
        toolName: call.name,
        status: 'failed',
        code,
        message,
      })
      this.saveCheckpoint(state, record.id, null)
      return {
        kind: 'failed',
        code,
        message,
        record: this.stepRecord(state, call, 'failed', { code, message }),
      }
    }
  }

  /** 内置工具：读 guide。读完之后该 Source 的工具才会解锁（FR-01.5）。 */
  private async executeGuideRead(
    state: RunState,
    call: AgentToolCall,
    toolCallId: string,
    emit: (type: EventType, payload: Record<string, unknown>) => void,
  ): Promise<CallOutcome> {
    const { toolCalls, guides, sessions } = this.deps
    // 目标 Source 的边界与激活状态已由 PreToolUse 检查过，这里不再重复判断。
    const sourceSlug = String(call.args['sourceSlug'])

    const source = this.deps.loadSource(sourceSlug)
    guides.markRead(state.session.id, sourceSlug)
    toolCalls.finish(toolCallId, 'succeeded', { resultRef: null })
    emit(EventType.GuideRead, {
      sourceSlug,
      guideVersion: source.version,
      bytes: source.guideText.length,
    })

    state.session = sessions.bumpStep(state.session.id, state.session.stateVersion)
    this.saveCheckpoint(state, toolCallId, null)

    return {
      kind: 'succeeded',
      result: null,
      // 把 guide 内容回给模型：它「读了」就应该看得见，否则「读 guide」
      // 只是一次没有信息量的握手。
      record: this.stepRecord(state, call, 'succeeded', {
        note: formatGuideNote(sourceSlug, source.guideText),
      }),
    }
  }

  /** Source 工具：走传输执行，结果过 Schema，落盘，做信封。 */
  private async executeSourceCall(
    state: RunState,
    call: AgentToolCall,
    tool: RegisteredTool,
    toolCallId: string,
    emit: (type: EventType, payload: Record<string, unknown>) => void,
  ): Promise<CallOutcome> {
    const { transports, toolCalls, sessions } = this.deps
    const { session } = state

    const transport = transports.get(tool.sourceSlug)
    if (!transport) {
      throw new ToolExecutionError(
        'SOURCE_NOT_ACTIVE',
        `Source "${tool.sourceSlug}" 没有可用的传输通道`,
      )
    }

    const execution = await transport.call(tool.toolName, call.args)

    // 结果契约校验：Source 返回了计划外的形状时，宁可失败也不让脏数据流进报表。
    const resultValidation = validateWithJsonSchema(tool.resultSchema, execution.data)
    if (!resultValidation.ok) {
      throw new ToolExecutionError(
        ErrorCode.TOOL_RESULT_SCHEMA_INVALID,
        `${tool.name} 的返回不符合结果契约：${resultValidation.message}`,
      )
    }

    const result: ToolResult = {
      resultId: newResultId(),
      toolName: tool.name,
      sourceRef: {
        slug: tool.sourceSlug,
        tool: tool.toolName,
        dataVersion: execution.meta.dataVersion,
      },
      completeness: execution.meta.completeness,
      data: execution.data,
      meta: execution.meta,
    }

    const outputRef = writeToolResult(session.id, result, this.deps.paths, this.deps.credentials)
    toolCalls.finish(toolCallId, 'succeeded', { resultRef: result.resultId })

    // 事件里只放摘要——明细不进轨迹，敏感数据尤其如此。
    emit(EventType.ToolCallCompleted, {
      toolCallId,
      toolName: call.name,
      resultId: result.resultId,
      dataVersion: result.sourceRef.dataVersion,
      completeness: result.completeness,
      rowCount: execution.meta.rowCount,
      outputRef,
    })

    state.session = sessions.bumpStep(session.id, session.stateVersion)
    this.saveCheckpoint(state, toolCallId, outputRef)

    return {
      kind: 'succeeded',
      result,
      record: this.stepRecord(state, call, 'succeeded', { result }),
    }
  }

  /**
   * 历史记录的构造点。
   *
   * `step` 用**库里那条 tool_call 的步号**而不是 `history.length`：
   * 恢复后的历史是重建出来的，两者不一定相等，用后者会让模板引用错位。
   */
  private stepRecord(
    state: RunState,
    call: AgentToolCall,
    status: AgentStepRecord['status'],
    extra: {
      step?: number
      code?: string
      message?: string
      result?: ToolResult
      note?: string
    } = {},
  ): AgentStepRecord {
    return {
      step: extra.step ?? state.history.length,
      toolName: call.name,
      args: call.args,
      status,
      ...(extra.result ? { result: extra.result } : {}),
      ...(extra.note !== undefined ? { note: extra.note } : {}),
      ...(extra.code !== undefined ? { errorCode: extra.code } : {}),
      ...(extra.message !== undefined ? { errorMessage: extra.message } : {}),
    }
  }

  private saveCheckpoint(
    state: RunState,
    toolCallId: string,
    outputRef: string | null,
    approvalRef: string | null = null,
  ): void {
    const checkpoint = this.deps.checkpoints.save({
      sessionId: state.session.id,
      step: state.session.step,
      stateVersion: state.session.stateVersion,
      inputVersion: state.session.inputVersion,
      outputRef,
      approvalRef,
      state: state.session.state,
    })
    this.deps.events.emit({
      sessionId: state.session.id,
      traceId: state.session.traceId,
      type: EventType.CheckpointSaved,
      payload: {
        step: checkpoint.step,
        stateVersion: checkpoint.stateVersion,
        state: checkpoint.state,
        outputRef,
        approvalRef,
        toolCallId,
      },
    })
  }

  private transition(
    state: RunState,
    to: Session['state'],
    patch: { errorCode?: string | null; errorMessage?: string | null } = {},
  ): Session {
    const from = state.session.state
    const updated = this.deps.sessions.transition(
      state.session.id,
      state.session.stateVersion,
      to,
      patch,
    )
    this.deps.events.emit({
      sessionId: updated.id,
      traceId: updated.traceId,
      type: EventType.StateChanged,
      payload: { from, to, step: updated.step, stateVersion: updated.stateVersion },
    })
    return updated
  }

  /**
   * 执行一条**已经拿到审批**的工具调用（发布流程用）。
   *
   * 与 `run` 的区别是它不规划、不推进状态机：调用方已经知道要执行哪一条，
   * 只需要借这里的判定链、Schema 校验、事件与检查点。
   * 即便带着已批准的审批进来，判定链仍会重跑一遍——
   * 审批有效才放行，绑定不符照样以 `APPROVAL_PARAMS_DRIFT` 拒绝。
   */
  async executeApprovedCall(
    sessionId: string,
    toolCallId: string,
    rationale = '执行已获审批的工具调用',
    options: { allowPublish?: boolean } = {},
  ): Promise<{ result: ToolResult | null; toolCallId: string }> {
    const session = this.deps.sessions.require(sessionId)
    const call = this.deps.toolCalls.require(toolCallId)

    if (call.sessionId !== sessionId) {
      fail(ErrorCode.SESSION_NOT_FOUND, `工具调用 ${toolCallId} 不属于 Session ${sessionId}`)
    }

    const state = this.buildState(session)
    const outcome = await this.runCall(
      state,
      { name: call.toolName, args: call.args },
      call,
      rationale,
      options,
    )

    switch (outcome.kind) {
      case 'succeeded':
        return { result: outcome.result, toolCallId }
      case 'denied':
        fail(
          (outcome.code as ErrorCode) ?? ErrorCode.APPROVAL_INVALID,
          outcome.record.errorMessage ?? '该调用被权限链拒绝',
          { toolCallId },
        )
      case 'failed':
        fail(outcome.code as ErrorCode, outcome.message, { toolCallId })
      case 'awaiting-approval':
        fail(ErrorCode.APPROVAL_REQUIRED, '该调用仍处于待审批状态', { toolCallId })
    }
  }

  private bareOutcome(session: Session): RunOutcome {
    return {
      sessionId: session.id,
      state: session.state,
      errorCode: session.errorCode,
      errorMessage: session.errorMessage,
      steps: 0,
      results: [],
      reportId: null,
      draftVersion: null,
      artifactPath: null,
      stoppedAtIndex: null,
      stoppedAtTool: null,
      approvalId: null,
      resumed: false,
    }
  }

  private buildOutcome(state: RunState, patch: OutcomePatch): RunOutcome {
    return {
      sessionId: state.session.id,
      state: state.session.state,
      errorCode: state.session.errorCode,
      errorMessage: state.session.errorMessage,
      steps: state.history.length,
      results: state.results,
      reportId: patch.reportId ?? null,
      draftVersion: patch.draftVersion ?? null,
      artifactPath: patch.artifactPath ?? null,
      stoppedAtIndex: patch.stoppedAtIndex ?? null,
      stoppedAtTool: patch.stoppedAtTool ?? null,
      approvalId: patch.approvalId ?? null,
      resumed: patch.resumed ?? false,
    }
  }
}
