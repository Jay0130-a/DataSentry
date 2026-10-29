import { Agent, type AgentEvent, type AgentTool, type BeforeToolCallContext, type StreamFn } from '@earendil-works/pi-agent-core'
import type { Api, Message, Model } from '@earendil-works/pi-ai'
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
  type Approval,
  type DataPaths,
  type LoadedSkill,
  type Report,
  type Session,
  type ToolResult,
} from '@datasentry/core'
import type { AgentContext } from './backend.ts'
import type { MockScript, MockStream } from './mock-stream.ts'
import { createMockStream } from './mock-stream.ts'
import { buildSystemPrompt, buildTaskPrompt, formatGuideNote, renderToolResult } from './prompt.ts'
import type { ToolRegistry } from '../harness/tool-registry.ts'
import type { RegisteredTool } from '../sources/builder.ts'
import type { GuideTracker } from '../harness/guide-tracker.ts'
import { isAgentCallableTool, READ_SOURCE_GUIDE_TOOL } from '../harness/tool-registry.ts'
import { evaluatePreToolUse, type PreToolUseResult } from '../harness/pretooluse.ts'
import type { ApprovalStore } from '../runtime/approval-store.ts'
import type { ApprovalGate } from '../runtime/approval-gate.ts'
import type { CheckpointStore } from '../runtime/checkpoint.ts'
import type { TranscriptStore } from '../runtime/transcript-store.ts'
import type { SessionStore } from '../runtime/session-store.ts'
import type { ToolCallStore } from '../runtime/tool-call-store.ts'
import type { LoadedSource } from '../sources/loader.ts'
import type { SourceTransport } from '../sources/transports/types.ts'
import { ToolExecutionError } from '../sources/transports/types.ts'
import type { EventStore } from '../events/event-store.ts'
import type { CredentialManager } from '../credentials/manager.ts'
import type { LoadedWorkspace } from '../workspace/loader.ts'
import { readToolResult, writeDraft, writeToolResult } from '../reports/draft.ts'
import { computeMetrics, metricInputsOf, requiredMetricsOf } from '../reports/metrics.ts'
import { validateReport } from '../reports/validate.ts'
import type { RunOutcome } from './loop.ts'
import { loadSkillPlan } from '../harness/skill-loader.ts'

/**
 * 用 pi-agent-core 的循环跑一次任务（PRD 迁移第 2 步）。
 *
 * 与 `AgentRunner` 的区别是**谁拥有循环**：
 * - `AgentRunner`：我们逐个调用模型、逐个执行工具、逐个落检查点
 * - 这里：pi 的 `Agent` 拥有循环，我们通过 `beforeToolCall` / `execute` 两个钩子
 *   把权限链、工具执行、事件与检查点挂回去
 *
 * 审批采用「hook 内 await」：`beforeToolCall` 挂起等 `ApprovalGate`，
 * 批准后从同一位置继续。不重放调用，参数天然一致。
 */
export interface PiLoopDeps {
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
  saveReport: (report: Report) => void
  approvalGate: ApprovalGate
  /** pi 的对话记录；跨重启恢复靠它。 */
  transcripts: TranscriptStore
  /** 真实模型的流函数。 */
  streamFn: StreamFn
  /** 真实模型对象；mock 脚本存在时可为空。 */
  model?: Model<Api>
  /** 可选：mock 脚本。给了就用脚本化模型，忽略 streamFn。 */
  mockScript?: MockScript
  maxSteps?: number
  approvalTtlMs?: number
}

interface RunState {
  session: Session
  workspace: LoadedWorkspace
  skill: LoadedSkill
  activeSourceSlugs: string[]
  /** tool_call 的步号 */
  step: number
  results: ToolResult[]
  /** 第一次被拒绝时记下原因，循环结束后据此进入 BLOCKED。 */
  denied: { code: string; message: string } | null
  /**
   * 工具执行失败。与 legacy 循环保持一致：取数失败是终局，
   * 不把错误当成「工具结果」让模型继续猜——缺数据算出来的报表比失败更危险。
   */
  fatal: { code: string; message: string } | null
  /** 本次执行中尚未结算的工具调用，按 pi 的 toolCallId 索引。 */
  pending: Map<string, { id: string; step: number }>
  /**
   * 已通过 beforeToolCall、尚未执行完的调用数。
   *
   * `state.step` 只在调用结束后递增；pi 会把一条 assistant 消息里的多个调用
   * 先全部过一遍 beforeToolCall 再并行执行，只数 step 会让一批调用一起越过上限。
   */
  inFlight: number
  mock: MockStream | null
  agent: Agent | null
  /** 最近一次发起（或被拒）的工具名，用于在结果里报告停在哪。 */
  lastTool: string | null
  /** pi 在钩子之前就拒绝的调用（参数 Schema 不合法），按 toolCallId 记下原始参数。 */
  rejectedBeforeHook: Map<string, { toolName: string; args: unknown }>
}

export class PiAgentRunner {
  private readonly maxSteps: number
  private readonly approvalTtlMs: number

  constructor(private readonly deps: PiLoopDeps) {
    this.maxSteps = deps.maxSteps ?? 40
    this.approvalTtlMs = deps.approvalTtlMs ?? 24 * 60 * 60 * 1000
  }

  async run(sessionId: string): Promise<RunOutcome> {
    const existing = this.deps.sessions.require(sessionId)
    if (isTerminal(existing.state)) {
      return this.outcome(entityState(existing), {})
    }

    // 停在审批上的任务，再次执行就是「从持久化状态恢复」。
    if (existing.state === SessionState.WAITING_APPROVAL) {
      return this.resume(sessionId)
    }

    // PAUSED 不能当作全新任务重跑：那会删掉 transcript、从 step 0 再执行一遍，
    // 已完成步骤被重放、步骤号重复。恢复交给 recovery 的检查点路径。
    if (existing.state === SessionState.PAUSED) {
      fail(
        ErrorCode.ILLEGAL_STATE_TRANSITION,
        `Session ${sessionId} 处于 PAUSED，pi 循环不支持就地恢复；请用 recover --execute 走检查点恢复`,
        { sessionId, state: existing.state },
      )
    }

    // 全新一轮：等状态转移校验通过后再清对话记录。
    // 先删再转的话，READY / MANUAL_REVIEW 这类非法入口会先把唯一的恢复锚点删掉，
    // 然后才在 transition 里抛错——什么都没跑，却永久丢了 transcript。
    const state: RunState = {
      session: existing,
      workspace: this.deps.loadWorkspace(existing.workspaceId),
      skill: this.deps.loadSkill(existing.skillName),
      activeSourceSlugs: [],
      step: 0,
      results: [],
      denied: null,

      fatal: null,
      pending: new Map(),
      mock: null,
      agent: null,
      lastTool: null,
      rejectedBeforeHook: new Map(),
      inFlight: 0,
    }

    state.activeSourceSlugs = state.skill.requiredSources.filter((slug) =>
      state.workspace.sources.includes(slug),
    )

    // —— INIT → PLANNING ——
    state.session = this.transition(state, SessionState.PLANNING)
    this.deps.transcripts.remove(sessionId)
    this.deps.events.emit({
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
        loop: 'pi-agent-core',
      },
    })
    for (const slug of state.activeSourceSlugs) {
      this.deps.events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.SourceActivated,
        payload: { sourceSlug: slug, reason: 'skill.requiredSources ∩ workspace.sources' },
      })
    }

    // 与 legacy 循环对齐：Skill 依赖了 Workspace 边界外的 Source 时留下轨迹。
    const notInWorkspace = state.skill.requiredSources.filter(
      (slug) => !state.workspace.sources.includes(slug),
    )
    if (notInWorkspace.length > 0) {
      this.deps.events.emit({
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

    if (this.deps.mockScript) {
      state.mock = createMockStream(this.deps.mockScript)
    }

    const streamFn = state.mock ? state.mock.streamFn : this.deps.streamFn
    const model = (state.mock?.model ?? this.deps.model) as Model<Api> | undefined
    if (!model) {
      state.session = this.transition(state, SessionState.FAILED, {
        errorCode: ErrorCode.MODEL_CONFIG_INVALID,
        errorMessage: 'pi 循环没有可用的模型',
      })
      return this.outcome(state, {})
    }

    const agent = new Agent({
      streamFn,
      initialState: {
        systemPrompt: this.buildSystemPrompt(state),
        model,
        tools: this.buildTools(state),
      },
      beforeToolCall: (ctx) => this.beforeToolCall(state, ctx),
    })
    state.agent = agent
    agent.subscribe((event) => this.handleAgentEvent(state, event))

    try {
      await agent.prompt(buildTaskPrompt(this.agentContext(state)))
    } catch (err) {
      if (!state.denied && !state.fatal) {
        const code = err instanceof DataSentryError ? err.code : ErrorCode.MODEL_CALL_FAILED
        const message = err instanceof Error ? err.message : String(err)
        state.session = this.transition(state, SessionState.FAILED, {
          errorCode: code,
          errorMessage: message,
        })
        return this.outcome(state, {})
      }
    }

    if (state.denied) {
      state.session = this.transition(state, SessionState.BLOCKED, {
        errorCode: state.denied.code,
        errorMessage: state.denied.message,
      })
      return this.outcome(state, {})
    }

    if (state.fatal) {
      state.session = this.transition(state, SessionState.FAILED, {
        errorCode: state.fatal.code,
        errorMessage: state.fatal.message,
      })
      return this.outcome(state, {})
    }

    if (state.step > this.maxSteps) {
      state.session = this.transition(state, SessionState.FAILED, {
        errorCode: ErrorCode.TOOL_EXECUTION_FAILED,
        errorMessage: `超过单任务步骤上限 ${this.maxSteps}，疑似规划器打转`,
      })
      return this.outcome(state, {})
    }

    return this.finalize(state)
  }

  /** 取数结束后：计算 → 校验 → 出稿。两套入口（首次执行与恢复）共用。 */
  private finalize(state: RunState): RunOutcome {
    // 与 legacy 循环对齐：规划阶段结束的事件，回归样本按它断言「取数已完成」。
    this.deps.events.emit({
      sessionId: state.session.id,
      traceId: state.session.traceId,
      type: EventType.PlanningCompleted,
      payload: { steps: state.step, loop: 'pi-agent-core' },
    })

    // —— FETCHING → COMPUTING ——
    state.session = this.transition(state, SessionState.COMPUTING)
    const computed = computeMetrics(state.results, metricInputsOf(state.workspace))
    for (const metric of computed.metrics) {
      this.deps.events.emit({
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
      this.deps.events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.ValidationFailed,
        payload: { failures: validation.failures, warnings: validation.warnings },
      })
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
      return this.outcome(state, {})
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
    this.deps.events.emit({
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
    this.deps.events.emit({
      sessionId: state.session.id,
      traceId: state.session.traceId,
      type: EventType.SessionCompleted,
      payload: {
        state: state.session.state,
        steps: state.step,
        metrics: artifact.metrics.map((m) => ({ key: m.key, value: m.value })),
      },
    })

    return this.outcome(state, {
      reportId: report.id,
      draftVersion: report.draftVersion,
      artifactPath: report.artifactPath,
    })
  }

  /**
   * 从审批等待中恢复（跨进程）。
   *
   * 依赖两样磁盘上的东西：
   * - `tool_call` 表里那条悬挂的调用与它的原参数
   * - `data/agents/<sessionId>.jsonl` 里的对话记录
   *
   * 恢复 = 执行掉被批准的调用 + 补一条 toolResult + 把对话放回 Agent 继续。
   * **不重新规划**：模型看到的仍是原来那份上下文。
   */
  private async resume(sessionId: string): Promise<RunOutcome> {
    const { sessions, approvals, toolCalls } = this.deps
    const session = sessions.require(sessionId)
    const state = this.createState(session)
    state.step = session.step

    const pending = toolCalls.pendingBySession(sessionId)
    if (pending.length !== 1) {
      fail(
        ErrorCode.SESSION_NOT_FOUND,
        `Session ${sessionId} 处于 ${session.state}，但悬挂的工具调用有 ${pending.length} 条（期望恰好 1 条）`,
        { sessionId },
      )
    }
    const call = pending[0]!

    // 记录自洽性检查：参数与摘要对不上，说明这条记录被改动过。
    // 只有跨进程恢复才需要它——进程内挂起时参数一直在内存里，不会与摘要分叉。
    // 排在权限检查之前：不是「能不能调」，而是「这条记录还作不作数」。
    const actualParamsHash = hashValue(call.args)
    if (actualParamsHash !== call.paramsHash) {
      const reason =
        `工具调用 ${call.id} 的参数与记录中的摘要不一致` +
        `（记录 ${call.paramsHash.slice(0, 12)}…，实算 ${actualParamsHash.slice(0, 12)}…），记录已被改动`
      toolCalls.finish(call.id, 'denied', {
        denyCode: ErrorCode.APPROVAL_PARAMS_DRIFT,
        denyReason: reason,
      })
      this.deps.events.emit({
        sessionId,
        traceId: session.traceId,
        type: EventType.ToolCallFailed,
        payload: {
          toolCallId: call.id,
          toolName: call.toolName,
          status: 'denied',
          code: ErrorCode.APPROVAL_PARAMS_DRIFT,
          reason,
        },
      })
      state.session = this.transition(state, SessionState.BLOCKED, {
        errorCode: ErrorCode.APPROVAL_PARAMS_DRIFT,
        errorMessage: reason,
      })
      return this.outcome(state, {})
    }

    const approval = approvals.byToolCall(call.id)
    if (!approval) {
      fail(ErrorCode.APPROVAL_INVALID, `工具调用 ${call.id} 上没有审批记录，无法恢复`, {
        toolCallId: call.id,
      })
    }

    // 仍未决：什么都不做，如实返回「还在等」。
    if (approval.status === ApprovalStatus.PENDING) {
      return this.outcome(state, {})
    }

    if (approval.status !== ApprovalStatus.GRANTED) {
      const code =
        approval.status === ApprovalStatus.EXPIRED
          ? ErrorCode.APPROVAL_EXPIRED
          : ErrorCode.APPROVAL_DENIED
      toolCalls.finish(call.id, 'denied', {
        denyCode: code,
        denyReason: approval.reason ?? `审批 ${approval.id} 状态为 ${approval.status}`,
      })
      state.session = this.transition(state, SessionState.BLOCKED, {
        errorCode: code,
        errorMessage: approval.reason ?? `审批 ${approval.id} 状态为 ${approval.status}`,
      })
      return this.outcome(state, {})
    }

    // 发布确认的执行入口是 confirmPublish，不是恢复重放。
    // 重放会让取数循环把整个报表再算一遍，留下「报表已发布、会话却回到 READY」。
    if (approval.kind === 'publish') {
      fail(
        ErrorCode.PUBLISH_CONFIRMATION_PENDING,
        `审批 ${approval.id} 是发布确认，执行入口是 confirm-publish，不能通过恢复重放`,
        { sessionId, approvalId: approval.id },
      )
    }

    /*
     * 跨重启恢复必须重跑整条权限链。
     *
     * 等待审批期间，审批可能过期，工具名字/版本可能变，Workspace 的 Source
     * 授权可能被收回。这里只比参数摘要是不够的——legacy 循环正是在
     * `runCall` 里重跑了一遍 PreToolUse，pi 的恢复不能走一条更宽松的旁路。
     */
    const tool = this.deps.registry.get(call.toolName)
    const verdict = this.checkToolCall(
      state,
      tool,
      call.toolName,
      call.args,
      // 参数与摘要的一致性已在上方核对过；这里用记录里的摘要做审批绑定比对。
      call.paramsHash,
      approval,
    )

    this.deps.events.emit({
      sessionId,
      traceId: session.traceId,
      type: EventType.PermissionDecided,
      payload: {
        toolCallId: call.id,
        toolName: call.toolName,
        effect: verdict.effect,
        code: verdict.code ?? null,
        reason: verdict.reason,
        checkedBy: verdict.checkedBy,
        approvalId: approval.id,
        resumed: true,
      },
    })

    if (verdict.effect !== 'allow') {
      const code = verdict.code ?? ErrorCode.APPROVAL_INVALID
      toolCalls.finish(call.id, 'denied', { denyCode: code, denyReason: verdict.reason })
      this.deps.events.emit({
        sessionId,
        traceId: session.traceId,
        type: EventType.ToolCallFailed,
        payload: {
          toolCallId: call.id,
          toolName: call.toolName,
          status: 'denied',
          code,
          reason: verdict.reason,
        },
      })
      state.session = this.transition(state, SessionState.BLOCKED, {
        errorCode: code,
        errorMessage: verdict.reason,
      })
      return this.outcome(state, {})
    }

    const transcript = this.deps.transcripts.read(sessionId)
    if (transcript.length === 0) {
      fail(ErrorCode.SESSION_NOT_FOUND, `Session ${sessionId} 缺少对话记录，无法恢复`, {
        sessionId,
      })
    }

    const toolCallId = findPendingToolCallId(transcript, call.toolName)
    if (!toolCallId) {
      fail(ErrorCode.APPROVAL_INVALID, `对话记录里找不到挂起的工具调用 "${call.toolName}"`, {
        sessionId,
        toolCallId: call.id,
      })
    }

    // mock 模式下，脚本进度必须与已完成步骤对齐，否则会重放已完成的步骤。
    this.restoreMock(state, sessionId)
    // 真实模型没有 mock 脚本，但指标计算同样需要跨重启读回**全部**已完成结果。
    // 只把这次重放的调用放进 state.results，会让报表在部分数据上计算。
    if (!this.deps.mockScript) this.restoreResults(state, sessionId)

    state.session = this.transition(state, SessionState.FETCHING, {
      errorCode: null,
      errorMessage: null,
    })

    if (!tool) {
      fail(ErrorCode.TOOL_NOT_REGISTERED, `工具 "${call.toolName}" 未注册，无法恢复`, {
        toolName: call.toolName,
      })
    }

    state.pending.set(toolCallId, { id: call.id, step: call.step })
    const executed = await this.executeTool(state, toolCallId, call.args, tool)

    const toolResultMessage: Message = {
      role: 'toolResult',
      toolCallId,
      toolName: call.toolName,
      content: executed.content,
      isError: executed.isError ?? false,
      timestamp: Date.now(),
    }
    this.deps.transcripts.append(sessionId, toolResultMessage)

    if (state.denied || state.fatal) {
      return this.settleAbnormal(state)
    }

    const model = (state.mock?.model ?? this.deps.model) as Model<Api> | undefined
    if (!model) {
      state.session = this.transition(state, SessionState.FAILED, {
        errorCode: ErrorCode.MODEL_CONFIG_INVALID,
        errorMessage: 'pi 循环没有可用的模型',
      })
      return this.outcome(state, {})
    }

    const agent = new Agent({
      streamFn: state.mock ? state.mock.streamFn : this.deps.streamFn,
      initialState: {
        systemPrompt: this.buildSystemPrompt(state),
        model,
        tools: this.buildTools(state),
        messages: [...transcript, toolResultMessage],
      },
      beforeToolCall: (ctx) => this.beforeToolCall(state, ctx),
    })
    state.agent = agent
    agent.subscribe((event) => this.handleAgentEvent(state, event))

    try {
      await agent.continue()
    } catch (err) {
      if (!state.denied && !state.fatal) {
        const code = err instanceof DataSentryError ? err.code : ErrorCode.MODEL_CALL_FAILED
        const message = err instanceof Error ? err.message : String(err)
        state.session = this.transition(state, SessionState.FAILED, {
          errorCode: code,
          errorMessage: message,
        })
        return this.outcome(state, {})
      }
    }

    if (state.denied || state.fatal) {
      return this.settleAbnormal(state)
    }

    this.deps.events.emit({
      sessionId: state.session.id,
      traceId: state.session.traceId,
      type: EventType.PlanningCompleted,
      payload: { steps: state.step, loop: 'pi-agent-core', resumed: true },
    })

    return this.finalize(state)
  }

  private settleAbnormal(state: RunState): RunOutcome {
    if (state.denied) {
      state.session = this.transition(state, SessionState.BLOCKED, {
        errorCode: state.denied.code,
        errorMessage: state.denied.message,
      })
    } else if (state.fatal) {
      state.session = this.transition(state, SessionState.FAILED, {
        errorCode: state.fatal.code,
        errorMessage: state.fatal.message,
      })
    }
    return this.outcome(state, {})
  }

  private createState(session: Session): RunState {
    const workspace = this.deps.loadWorkspace(session.workspaceId)
    const skill = this.deps.loadSkill(session.skillName)
    return {
      session,
      workspace,
      skill,
      activeSourceSlugs: skill.requiredSources.filter((slug) => workspace.sources.includes(slug)),
      step: 0,
      results: [],
      denied: null,
      fatal: null,
      pending: new Map(),
      mock: null,
      agent: null,
      lastTool: null,
      rejectedBeforeHook: new Map(),
      inFlight: 0,
    }
  }

  /**
   * 重建 mock 脚本进度。
   *
   * 脚本是按步骤下标的，重启后必须把已完成步骤「跳过去」，否则会重放。
   * 结果也从磁盘读回来——模板插值需要它们。
   */
  /** 从落盘结果重建 `state.results`（真实模型恢复用）。 */
  private restoreResults(state: RunState, sessionId: string): void {
    const results: ToolResult[] = []
    for (const call of this.deps.toolCalls.listBySession(sessionId)) {
      if (call.status !== 'succeeded' || !call.resultRef) continue
      const result = readToolResult(sessionId, call.resultRef, this.deps.paths)
      if (result) results.push(result)
    }
    state.results = results
  }

  private restoreMock(state: RunState, sessionId: string): void {
    const template = this.deps.mockScript
    if (!template) return

    const plan = template.plan
    const script: MockScript = {
      plan,
      input: state.session.input,
      sessionId,
      results: {},
      index: 0,
    }

    const calls = this.deps.toolCalls
      .listBySession(sessionId)
      .filter((call) => call.status !== 'pending')

    calls.forEach((call, index) => {
      if (call.status !== 'succeeded' || !call.resultRef) return
      const result = readToolResult(sessionId, call.resultRef, this.deps.paths)
      if (!result) return
      const stepId = plan.steps[index]?.id
      if (stepId) script.results[stepId] = result
      state.results.push(result)
    })

    script.index = calls.length
    state.step = calls.length
    state.mock = createMockStream(script)
  }

  // —— 钩子 ——

  /**
   * pi 在 `beforeToolCall` **之前**就校验参数 Schema。
   * 非法参数不会进钩子，而是直接产生一条 error toolResult。
   *
   * 我们的语义是「Schema 非法 = 硬拒绝 = BLOCKED」，所以在这里把它认出来，
   * 补一条被拒的工具调用记录，然后中止循环。判据：`turn_end` 里出现一条
   * 没有经过我们钩子的错误结果。
   */
  private handleAgentEvent(state: RunState, event: AgentEvent): void {
    // 对话记录落盘：跨重启恢复的唯一依据。
    if (event.type === 'message_end') {
      this.deps.transcripts.append(state.session.id, event.message as unknown as Message)
      return
    }
    if (event.type === 'tool_execution_start') {
      state.rejectedBeforeHook.set(event.toolCallId, {
        toolName: event.toolName,
        args: event.args,
      })
      return
    }
    if (event.type !== 'turn_end') return
    if (state.fatal || state.denied) return

    for (const result of event.toolResults) {
      if (state.pending.has(result.toolCallId)) continue
      if (!result.isError) continue

      const info = state.rejectedBeforeHook.get(result.toolCallId)
      const message = result.content
        .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
        .trim()

      const args = (info?.args ?? {}) as Record<string, unknown>
      const tool = this.deps.registry.get(result.toolName)
      const record = this.deps.toolCalls.create({
        sessionId: state.session.id,
        step: state.step,
        toolName: result.toolName,
        sourceSlug: tool?.sourceSlug ?? 'unknown',
        paramsHash: hashValue(args),
        toolVersion: tool?.toolVersion ?? 'unregistered',
        args,
      })

      this.deps.toolCalls.finish(record.id, 'denied', {
        denyCode: ErrorCode.SCHEMA_INVALID,
        denyReason: message || '参数不符合工具契约',
      })
      this.deps.events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.ToolCallRequested,
        payload: {
          toolCallId: record.id,
          step: state.step,
          toolName: result.toolName,
          sourceSlug: tool?.sourceSlug ?? 'unknown',
          paramsHash: hashValue(args),
          args,
          rejectedBy: 'pi-schema-validation',
        },
      })
      this.deps.events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.PermissionDecided,
        payload: {
          toolCallId: record.id,
          toolName: result.toolName,
          effect: 'deny',
          code: ErrorCode.SCHEMA_INVALID,
          reason: message || '参数不符合工具契约',
          checkedBy: 'pi-schema-validation',
        },
      })
      this.deps.events.emit({
        sessionId: state.session.id,
        traceId: state.session.traceId,
        type: EventType.ToolCallFailed,
        payload: {
          toolCallId: record.id,
          toolName: result.toolName,
          status: 'denied',
          code: ErrorCode.SCHEMA_INVALID,
          reason: message || '参数不符合工具契约',
        },
      })

      state.step += 1
      state.lastTool = result.toolName
      // 与 legacy 一致：Schema 非法属于「被拒绝」，任务停在 BLOCKED，而不是 FAILED。
      state.denied = {
        code: ErrorCode.SCHEMA_INVALID,
        message: message || '参数不符合工具契约',
      }
      state.agent?.abort()
      return
    }
  }

  private buildTools(state: RunState): AgentTool[] {
    return this.deps.registry
      .list()
      .filter(isAgentCallableTool)
      .map((tool) => ({
        name: tool.name,
        label: tool.title,
        description: tool.description,
        // 我们的工具契约本来就是 JSON Schema，运行时与 TypeBox 同构。
        parameters: tool.paramsSchema as never,
        execute: async (callId, params) =>
          this.executeTool(state, callId, params as Record<string, unknown>, tool),
      }))
  }

  /**
   * 用当前状态构造一次完整的 PreToolUse 判定。
   *
   * 新调用、审批等待唤醒、跨重启恢复都走这同一份逻辑——否则三条路径里迟早
   * 会有一条忘了检查有效期、边界或 guide。
   */
  private checkToolCall(
    state: RunState,
    tool: RegisteredTool | undefined,
    toolName: string,
    args: Record<string, unknown>,
    paramsHash: string,
    approval: Approval | undefined,
  ): PreToolUseResult {
    return evaluatePreToolUse({
      toolName,
      args,
      tool,
      subjectSourceSlug: subjectOf(tool, args),
      workspaceSourceSlugs: state.workspace.sources,
      activeSourceSlugs: state.activeSourceSlugs,
      guideRead: (slug) => this.deps.guides.hasRead(state.session.id, slug),
      permissionMode: state.workspace.defaultPermissionMode,
      paramsHash,
      approval,
    })
  }

  private async beforeToolCall(
    state: RunState,
    ctx: BeforeToolCallContext,
  ): Promise<{ block?: boolean; reason?: string } | undefined> {
    const { registry, events, toolCalls, approvals, guides, sessions } = this.deps
    const call = ctx.toolCall
    const args = (ctx.args ?? {}) as Record<string, unknown>
    const tool = registry.get(call.name)
    state.lastTool = call.name

    const paramsHash = hashValue(args)
    const record = toolCalls.create({
      sessionId: state.session.id,
      step: state.step,
      toolName: call.name,
      sourceSlug: tool?.sourceSlug ?? 'unknown',
      paramsHash,
      toolVersion: tool?.toolVersion ?? 'unregistered',
      args,
    })
    state.pending.set(call.id, { id: record.id, step: state.step })

    const emit = (type: EventType, payload: Record<string, unknown>): void => {
      events.emit({ sessionId: state.session.id, traceId: state.session.traceId, type, payload })
    }

    emit(EventType.ToolCallRequested, {
      toolCallId: record.id,
      step: state.step,
      toolName: call.name,
      sourceSlug: tool?.sourceSlug ?? 'unknown',
      paramsHash,
      args,
      loop: 'pi-agent-core',
    })

    /*
     * 步骤上限必须在**执行前**检查。
     *
     * 只在 agent.prompt()/continue() 返回后检查，对真实模型没有约束力：
     * 模型可以一直调工具、循环一直不返回，会话就永远到不了那行检查。
     */
    if (state.step + state.inFlight >= this.maxSteps) {
      const message = `超过单任务步骤上限 ${this.maxSteps}，疑似规划器打转`
      toolCalls.finish(record.id, 'failed', {
        denyCode: ErrorCode.TOOL_EXECUTION_FAILED,
        denyReason: message,
      })
      emit(EventType.ToolCallFailed, {
        toolCallId: record.id,
        toolName: call.name,
        status: 'failed',
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        reason: message,
      })
      state.fatal = { code: ErrorCode.TOOL_EXECUTION_FAILED, message }
      state.agent?.abort()
      return { block: true, reason: message }
    }

    const verdict = this.checkToolCall(
      state,
      tool,
      call.name,
      args,
      paramsHash,
      approvals.byToolCall(record.id),
    )

    emit(EventType.PermissionDecided, {
      toolCallId: record.id,
      toolName: call.name,
      effect: verdict.effect,
      code: verdict.code ?? null,
      reason: verdict.reason,
      checkedBy: verdict.checkedBy,
      approvalId: null,
    })

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
      state.denied = { code, message: verdict.reason }
      state.agent?.abort()
      return { block: true, reason: verdict.reason }
    }

    // —— 需要审批：原地挂起，等人决定 ——
    if (verdict.effect === 'ask') {
      const created = approvals.create({
        sessionId: state.session.id,
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
        args,
        reason: verdict.reason,
        expiresAt: created.expiresAt,
      })

      // 先进等待态，再挂起——顺序反了的话，审批接口会看到任务还在 FETCHING。
      state.session = this.transition(state, SessionState.WAITING_APPROVAL)
      this.saveCheckpoint(state, record.id, null, created.id)

      const decision = await this.deps.approvalGate.waitFor(created.id)

      if (decision !== 'granted') {
        const code = decision === 'expired' ? ErrorCode.APPROVAL_EXPIRED : ErrorCode.APPROVAL_DENIED
        toolCalls.finish(record.id, 'denied', { denyCode: code, denyReason: verdict.reason })
        emit(EventType.ToolCallFailed, {
          toolCallId: record.id,
          toolName: call.name,
          status: 'denied',
          code,
          reason: verdict.reason,
        })
        state.denied = { code, message: `审批 ${created.id} 被拒绝或过期` }
        state.agent?.abort()
        return { block: true, reason: state.denied.message }
      }

      // 批准：等待期间审批可能已过期/被吊销，工具版本或 Source 授权也可能变。
      // 执行前用同一份判定链再核对一次，而不是相信「刚才的结果」。
      const granted = approvals.byToolCall(record.id)
      const recheck = this.checkToolCall(state, tool, call.name, args, paramsHash, granted)
      emit(EventType.PermissionDecided, {
        toolCallId: record.id,
        toolName: call.name,
        effect: recheck.effect,
        code: recheck.code ?? null,
        reason: recheck.reason,
        checkedBy: recheck.checkedBy,
        approvalId: granted?.id ?? created.id,
        recheckedAfterApproval: true,
      })

      if (recheck.effect !== 'allow') {
        const code = recheck.code ?? ErrorCode.APPROVAL_INVALID
        toolCalls.finish(record.id, 'denied', { denyCode: code, denyReason: recheck.reason })
        emit(EventType.ToolCallFailed, {
          toolCallId: record.id,
          toolName: call.name,
          status: 'denied',
          code,
          reason: recheck.reason,
        })
        state.denied = { code, message: recheck.reason }
        state.agent?.abort()
        return { block: true, reason: recheck.reason }
      }

      // 批准且复核通过：回到取数态，继续同一次调用。
      state.session = this.transition(state, SessionState.FETCHING, {
        errorCode: null,
        errorMessage: null,
      })
      state.inFlight += 1
      return undefined
    }

    state.inFlight += 1
    return undefined
  }

  private async executeTool(
    state: RunState,
    callId: string,
    args: Record<string, unknown>,
    tool: RegisteredTool,
  ): Promise<{ content: { type: 'text'; text: string }[]; details: unknown; isError?: boolean }> {
    const pending = state.pending.get(callId)
    if (!pending) {
      throw new Error(`工具调用 ${callId} 没有对应的记录——beforeToolCall 可能被跳过`)
    }

    const { toolCalls, events, transports, guides, sessions } = this.deps
    const emit = (type: EventType, payload: Record<string, unknown>): void => {
      events.emit({ sessionId: state.session.id, traceId: state.session.traceId, type, payload })
    }

    try {
      // 内置工具：读 guide
      if (tool.kind === 'builtin' && tool.name === READ_SOURCE_GUIDE_TOOL) {
        const slug = String(args['sourceSlug'])
        const source = this.deps.loadSource(slug)
        guides.markRead(state.session.id, slug)
        toolCalls.finish(pending.id, 'succeeded', { resultRef: null })
        emit(EventType.GuideRead, {
          sourceSlug: slug,
          guideVersion: source.version,
          bytes: source.guideText.length,
        })
        state.session = sessions.bumpStep(state.session.id, state.session.stateVersion)
        state.step += 1
        this.saveCheckpoint(state, pending.id, null)
        state.mock?.advance(state.mock.currentStepId() ?? '', undefined)
        return { content: [{ type: 'text', text: formatGuideNote(slug, source.guideText) }], details: null }
      }

      const transport = transports.get(tool.sourceSlug)
      if (!transport) {
        throw new ToolExecutionError('SOURCE_NOT_ACTIVE', `Source "${tool.sourceSlug}" 没有可用的传输通道`)
      }

      const execution = await transport.call(tool.toolName, args)

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

      const outputRef = writeToolResult(state.session.id, result, this.deps.paths, this.deps.credentials)
      toolCalls.finish(pending.id, 'succeeded', { resultRef: result.resultId })
      emit(EventType.ToolCallCompleted, {
        toolCallId: pending.id,
        toolName: tool.name,
        resultId: result.resultId,
        dataVersion: result.sourceRef.dataVersion,
        completeness: result.completeness,
        rowCount: execution.meta.rowCount,
        outputRef,
      })

      state.results.push(result)
      const stepId = state.mock?.currentStepId()
      state.session = sessions.bumpStep(state.session.id, state.session.stateVersion)
      state.step += 1
      this.saveCheckpoint(state, pending.id, outputRef)
      if (stepId) state.mock?.advance(stepId, result)

      return {
        content: [{ type: 'text', text: renderToolResult({ step: pending.step, toolName: tool.name, args, status: 'succeeded', result }) }],
        details: result,
      }
    } catch (err) {
      const code = err instanceof ToolExecutionError ? err.code : ErrorCode.TOOL_EXECUTION_FAILED
      const message = err instanceof Error ? err.message : String(err)
      toolCalls.finish(pending.id, 'failed', { denyCode: code, denyReason: message })
      emit(EventType.ToolCallFailed, {
        toolCallId: pending.id,
        toolName: tool.name,
        status: 'failed',
        code,
        message,
      })
      state.session = sessions.bumpStep(state.session.id, state.session.stateVersion)
      state.step += 1
      this.saveCheckpoint(state, pending.id, null)
      state.fatal = { code, message }
      state.agent?.abort()
      return {
        content: [{ type: 'text', text: `调用未成功：${code} ${message}` }],
        details: null,
        isError: true,
      }
    } finally {
      state.inFlight = Math.max(0, state.inFlight - 1)
    }
  }

  // —— 辅助 ——

  private agentContext(state: RunState): AgentContext {
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
      tools: this.deps.registry
        .list()
        .filter(isAgentCallableTool)
        .map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          paramsSchema: tool.paramsSchema,
          guideRead:
            tool.kind === 'builtin' || this.deps.guides.hasRead(state.session.id, tool.sourceSlug),
        })),
      // 与 legacy 一致：只把「模型真的能调」的 Source 写进提示词，
      // 发布源保留在激活集合里供 confirmPublish 使用。
      activeSourceSlugs: state.activeSourceSlugs.filter((slug) =>
        this.deps.registry.bySource(slug).some(isAgentCallableTool),
      ),
      history: [],
    }
  }

  private buildSystemPrompt(state: RunState): string {
    return buildSystemPrompt(this.agentContext(state))
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
      payload: { from, to, step: updated.step, stateVersion: updated.stateVersion, loop: 'pi-agent-core' },
    })
    return updated
  }

  private outcome(
    state: RunState,
    patch: {
      reportId?: string | null
      draftVersion?: string | null
      artifactPath?: string | null
    },
  ): RunOutcome {
    return {
      sessionId: state.session.id,
      state: state.session.state,
      errorCode: state.session.errorCode,
      errorMessage: state.session.errorMessage,
      steps: state.step,
      results: state.results,
      reportId: patch.reportId ?? null,
      draftVersion: patch.draftVersion ?? null,
      artifactPath: patch.artifactPath ?? null,
      stoppedAtIndex: state.denied || state.fatal ? state.step - 1 : null,
      stoppedAtTool: state.denied || state.fatal ? state.lastTool : null,
      approvalId: null,
      resumed: false,
    }
  }
}

function entityState(session: Session): RunState {
  return {
    session,
    workspace: null as unknown as LoadedWorkspace,
    skill: null as unknown as LoadedSkill,
    activeSourceSlugs: [],
    step: 0,
    results: [],
    denied: null,
    fatal: null,
    pending: new Map(),
    mock: null,
    agent: null,
    lastTool: null,
    rejectedBeforeHook: new Map(),
    inFlight: 0,
  }
}

/** 与 AgentRunner 的 `subjectSourceOf` 同义：读 guide 的主体是它指定的目标 Source。 */
/**
 * 在对话记录里找到挂起的那次工具调用（pi 的 toolCallId）。
 *
 * 只检查最后一条 assistant：挂起的调用一定是它发出的，之后的 toolResult 还没写。
 */
function findPendingToolCallId(messages: readonly Message[], toolName: string): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue

    const calls = message.content.filter((item) => item.type === 'toolCall') as Array<{
      id: string
      name: string
    }>
    const match = [...calls].reverse().find((call) => call.name === toolName)
    return match?.id ?? null
  }
  return null
}

function subjectOf(tool: RegisteredTool | undefined, args: Record<string, unknown>): string | null {
  if (!tool) return null
  if (tool.kind === 'source') return tool.sourceSlug
  if (tool.name === READ_SOURCE_GUIDE_TOOL) {
    const target = args['sourceSlug']
    return typeof target === 'string' && target.length > 0 ? target : null
  }
  return null
}
