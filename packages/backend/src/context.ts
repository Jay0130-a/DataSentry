import {
  ApprovalStatus,
  dataPaths,
  ErrorCode,
  EventType,
  fail,
  SessionState,
  type Approval,
  type CreateSessionInput,
  type DataPaths,
  type ManualReviewInput,
  type Session,
} from '@datasentry/core'
import { AgentRunner, type RunOutcome } from './agent/loop.ts'
import { ClaudeAgentBackend, createClaudeClient } from './agent/claude-backend.ts'
import {
  describeModelConfig,
  loadModelConfig,
  ModelProvider,
  resolveModelCredentials,
  type ModelConfig,
} from './agent/model-config.ts'
import { MockAgentBackend } from './agent/mock-backend.ts'
import { createOpenAiCompatibleBackend, OpenAiCompatibleBackend } from './agent/openai-backend.ts'
import { PiAiBackend, createPiRuntime } from './agent/pi-ai-backend.ts'
import { PiAgentRunner } from './agent/pi-loop.ts'
import { createMockScript } from './agent/mock-stream.ts'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { AgentBackend } from './agent/backend.ts'
import { AuthService } from './auth/service.ts'
import { CredentialManager } from './credentials/manager.ts'
import { openDatabase, type DatabaseHandle } from './db/index.ts'
import { loadLocalEnv } from './env.ts'
import { EventStore } from './events/event-store.ts'
import { loadSkill, loadSkillPlan, type SkillPlan } from './harness/skill-loader.ts'
import { builtinTools, ToolRegistry } from './harness/tool-registry.ts'
import { GuideTracker } from './harness/guide-tracker.ts'
import type { PublishChannel, PublishFormat } from './reports/publishing.ts'
import { resolvePeriod } from './reports/request-parser.ts'
import { renderReportArtifact } from './reports/renderers/index.ts'
import {
  PublishService,
  type ConfirmPublishResult,
  type ReconcileResult,
  type RequestPublishResult,
} from './reports/publish-service.ts'
import { ApprovalStore } from './runtime/approval-store.ts'
import { ApprovalGate } from './runtime/approval-gate.ts'
import { TranscriptStore } from './runtime/transcript-store.ts'
import { CheckpointStore } from './runtime/checkpoint.ts'
import { applyApprovalDenial, RecoveryService, type RecoveryResult } from './runtime/recovery.ts'
import { ReportStore } from './runtime/report-store.ts'
import { SessionStore } from './runtime/session-store.ts'
import { ToolCallStore } from './runtime/tool-call-store.ts'
import { SourceServerBuilder, type BuiltSources } from './sources/builder.ts'
import { loadSource, type LoadedSource } from './sources/loader.ts'
import {
  findReceipt,
  hasPublishIntent,
  publishDedupeKey,
  readReceipts,
  receiptsForReport,
  type PublishReceipt,
} from './sources/local-handlers/publish-gateway.ts'
import { ManagedServiceManager } from './sources/managed-services.ts'
import type { SourceTransport } from './sources/transports/types.ts'
import { loadWorkspace, type LoadedWorkspace } from './workspace/loader.ts'

export interface AppContextOptions {
  paths?: DataPaths
  maxSteps?: number
  /** 审批有效期，毫秒。测试用它把「审批过期」变成可测的路径。 */
  approvalTtlMs?: number
  /**
   * 强制指定的模型后端，优先于 `datasentry.config.json`。
   *
   * 回归与测试用它把确定性锁死：**验证边界的那套测试，不能被被验证对象的配置影响**。
   */
  modelProvider?: ModelProvider
  /**
   * 用哪套循环：
   * - `legacy`（默认）：我们自己的 AgentRunner，逐步骤执行
   * - `pi`：pi-agent-core 的 Agent，权限链挂在 `beforeToolCall` 上
   */
  agentLoop?: 'legacy' | 'pi'
}

export interface DecideApprovalInput {
  decision: 'granted' | 'denied'
  approver: string
  reason?: string
}

/**
 * 应用装配点。
 *
 * 依赖是显式构造并层层注入的，没有模块级单例——回归脚本要能在一个进程里
 * 建多个互相隔离的 context（各自独立的临时数据目录），单例会直接毁掉这一点。
 */
export interface AppContext {
  readonly paths: DataPaths
  readonly credentials: CredentialManager
  readonly database: DatabaseHandle
  readonly auth: AuthService
  readonly events: EventStore
  readonly sessions: SessionStore
  readonly toolCalls: ToolCallStore
  readonly checkpoints: CheckpointStore
  readonly approvals: ApprovalStore
  readonly reports: ReportStore
  readonly guides: GuideTracker
  readonly registry: ToolRegistry
  readonly managed: ManagedServiceManager
  readonly builder: SourceServerBuilder
  readonly publishing: PublishService
  readonly recovery: RecoveryService
  /** 当前生效的模型配置。`describe()` 永远不返回密钥本身。 */
  readonly model: {
    config: ModelConfig
    describe: () => Record<string, unknown>
  }

  /** 建立 Source 连接与工具（幂等，首次调用时才 spawn 子进程）。 */
  ensureSources(): Promise<BuiltSources>
  transports(): Map<string, SourceTransport>

  loadWorkspace: (ref: string) => LoadedWorkspace
  loadSource: (slug: string) => LoadedSource

  /** `actor` 是登录账号；CLI 与回归不传，任务记为「无发起人」。 */
  createSession(input: CreateSessionInput, actor?: { userId: string }): Session
  /**
   * 执行任务。
   *
   * - `INIT` 从头跑（规划 → 取数 → 计算 → 草稿）
   * - `WAITING_APPROVAL` 走恢复路径：重放原 ToolCall，不重新规划
   *
   * `options.plan` 可以替换 Skill 自带的 `plan.yaml`——回归样本用它构造
   * 负向路径（跳过 guide、非法参数、跨 Workspace），而不必为每种违规
   * 单独建一个 Skill 目录。这也是「换规划器」这个扩展点的自然形态。
   */
  runSession(sessionId: string, options?: { plan?: SkillPlan }): Promise<RunOutcome>

  /** 审批**只记录决定**，不触发执行——批准与执行由不同的人在前后两步完成。 */
  decideApproval(approvalId: string, input: DecideApprovalInput): Approval
  /**
   * 恢复被审批打断的任务。
   *
   * `options.plan` 必须与当初 `runSession` 传的**是同一份**：恢复只重放被批准的那一步，
   * 之后还要继续往下走（预算、数仓、手工调整…），而那一段是由规划器决定的。
   * 覆盖了计划却不在这里覆盖，恢复就会沿着 Skill 自带的计划跑——
   * 生产环境不会发生（从来只有一份计划），但调用方覆盖过就必须一路覆盖。
   */
  resumeSession(sessionId: string, options?: { plan?: SkillPlan }): Promise<RunOutcome>
  /**
   * 处置 `MANUAL_REVIEW` 任务（管理员动作）。
   *
   * 状态机只允许 MANUAL_REVIEW → PAUSED / READY / DONE / BLOCKED / FAILED；
   * 这里不自动执行任何工具，只把人工结论落到状态并写事件。
   */
  resolveManualReview(
    sessionId: string,
    input: ManualReviewInput,
    actor?: { userId?: string; displayName?: string },
  ): Session
  /** 发起发布确认（前置校验 + 渲染文件 + 绑定草稿版本、接收人、格式）。 */
  requestPublish(
    reportId: string,
    request: { recipients: readonly string[]; channel: PublishChannel; format: PublishFormat },
  ): Promise<RequestPublishResult>
  /** 确认并执行发布。 */
  confirmPublish(approvalId: string): Promise<ConfirmPublishResult>
  /**
   * 结果未知时查回执（FR-06.3）。
   *
   * 针对「网关已投递、进程在写回记账之前挂掉」那个窗口：先查回执，
   * 已发送就补齐记账**不重发**，未确认就转人工。这个方法从不调用发布工具。
   */
  reconcilePublish(sessionId: string): Promise<ReconcileResult>
  /** 某个报表的全部回执，按发布时间升序。 */
  publishReceipts(reportId: string): PublishReceipt[]
  /** 网关里的全部回执。用于「没有报表也要证明没有投递」的断言。 */
  allPublishReceipts(): PublishReceipt[]

  /**
   * 重启后核对中断的任务。
   *
   * `execute=false` 只做状态收敛，不执行任何 Source 调用；
   * `execute=true` 才会把可继续的任务真正跑下去。
   * 分开是为了让运维先看清楚再决定，而不是一启动就自动执行一堆带副作用的动作。
   */
  runRecovery(options?: {
    execute?: boolean
    sessionIds?: readonly string[]
    /** 同 `resumeSession`：覆盖过计划就要在这里也覆盖。 */
    plan?: SkillPlan
  }): Promise<RecoveryResult>

  close(): Promise<void>
}

export async function createAppContext(options: AppContextOptions = {}): Promise<AppContext> {
  // `.env` 必须在 `dataPaths()` 之前加载：DATASENTRY_DATA_DIR / DATASENTRY_ROOT
  // 就写在里面，晚一步读就会落到另一个数据目录。
  if (!options.paths) loadLocalEnv()
  const paths = options.paths ?? dataPaths()
  loadLocalEnv(paths)

  const maxSteps = options.maxSteps
  const agentLoop: 'legacy' | 'pi' =
    options.agentLoop ?? (process.env['DATASENTRY_AGENT_LOOP'] === 'pi' ? 'pi' : 'legacy')
  const approvalTtlMs = options.approvalTtlMs
  const credentials = CredentialManager.load(paths)
  const database = openDatabase(paths)
  const auth = new AuthService(database)

  /*
   * 模型配置在**启动时**解析并校验。
   *
   * 配置写错（拼错 provider、选了真实的 provider 却没有密钥）应当立刻失败，
   * 而不是等第一个任务跑到一半才报一个难懂的错。
   */
  const modelConfig = options.modelProvider
    ? { ...loadModelConfig(paths), provider: options.modelProvider }
    : loadModelConfig(paths)
  const modelCredentials = resolveModelCredentials(modelConfig)

  let claudeBackend: ClaudeAgentBackend | null = null
  let openAiBackend: OpenAiCompatibleBackend | null = null
  let piBackend: PiAiBackend | null = null
  let piRuntime: ReturnType<typeof createPiRuntime> | null = null

  if (modelConfig.provider === ModelProvider.ANTHROPIC) {
    if (!modelCredentials.apiKey) {
      fail(
        ErrorCode.MODEL_CONFIG_INVALID,
        `模型配置为 anthropic，但没有找到 API key。请设置 ${modelConfig.apiKeyEnv} 或 ANTHROPIC_API_KEY（密钥不写进配置文件）`,
        { model: modelConfig.name, apiKeyEnv: modelConfig.apiKeyEnv },
      )
    }
    claudeBackend = new ClaudeAgentBackend({
      config: modelConfig,
      client: createClaudeClient({
        apiKey: modelCredentials.apiKey,
        baseUrl: modelCredentials.baseUrl,
      }),
    })
  }

  if (modelConfig.provider === ModelProvider.OPENAI_COMPATIBLE) {
    if (!modelCredentials.apiKey) {
      fail(
        ErrorCode.MODEL_CONFIG_INVALID,
        `模型配置为 openai-compatible，但没有找到 API key。请设置 ${modelConfig.apiKeyEnv} 或 DASHSCOPE_API_KEY（千问）`,
        { model: modelConfig.name, apiKeyEnv: modelConfig.apiKeyEnv },
      )
    }
    if (!modelCredentials.baseUrl) {
      fail(ErrorCode.MODEL_CONFIG_INVALID, 'openai-compatible 端点缺少 baseUrl', {
        model: modelConfig.name,
      })
    }
    openAiBackend = createOpenAiCompatibleBackend({
      config: modelConfig,
      apiKey: modelCredentials.apiKey,
      baseUrl: modelCredentials.baseUrl,
    })
  }

  if (modelConfig.provider === ModelProvider.PI) {
    if (!modelCredentials.apiKey) {
      fail(
        ErrorCode.MODEL_CONFIG_INVALID,
        `模型配置为 pi，但没有找到 API key。请设置 ${modelConfig.apiKeyEnv}（pi 背后的厂商不固定，不做自动回落）`,
        { model: modelConfig.name, piProvider: modelConfig.piProvider },
      )
    }
    // 模型在启动时解析：写错 provider/model id 应当立刻失败，而不是等第一次调用。
    // 目录里没有但给了 baseUrl 时，会退到自定义 provider（任意 OpenAI 兼容端点）。
    const runtime = createPiRuntime(modelConfig, modelCredentials.apiKey)
    piRuntime = runtime
    piBackend = new PiAiBackend({
      config: modelConfig,
      model: runtime.model,
      apiKey: modelCredentials.apiKey,
      client: runtime.client,
    })
  }

  const events = new EventStore(database.db, paths, credentials, database.sqlite)
  const sessions = new SessionStore(database.db)
  const toolCalls = new ToolCallStore(database.db)
  const checkpoints = new CheckpointStore(database.db)
  const approvals = new ApprovalStore(database.db)
  const reports = new ReportStore(database.db)
  /**
   * 审批闸门：pi 循环在 `beforeToolCall` 里挂起等人，`decideApproval` 负责唤醒。
   * 只在内存里——跨进程恢复留给第 3 步的 durable。
   */
  const approvalGate = new ApprovalGate()
  const transcripts = new TranscriptStore(paths)
  // guide 已读状态回查到事件轨迹：进程重启后 guide 约束依然成立（M3 恢复的前提）。
  const guides = new GuideTracker((sessionId, slug) => events.hasGuideRead(sessionId, slug))
  const registry = new ToolRegistry()
  const managed = new ManagedServiceManager()

  const builder = new SourceServerBuilder({ paths, credentials, managed })

  let built: BuiltSources | null = null
  let transportsById = new Map<string, SourceTransport>()

  const ensureSources = async (): Promise<BuiltSources> => {
    if (built) return built
    built = await builder.build()
    registry.addAll(builtinTools())
    registry.addAll(built.tools)
    transportsById = built.transports
    return built
  }

  const loadWorkspaceFn = (ref: string): LoadedWorkspace => loadWorkspace(ref, paths)
  const loadSourceFn = (slug: string): LoadedSource => loadSource(slug, paths)

  /** 发布网关的回执文件路径。结果未知时查回执、以及回执查询接口都走它。 */
  const publishReceiptsFile = (): string => {
    const config = loadSourceFn('publish').config
    if (config.type !== 'local') {
      fail(ErrorCode.RECEIPT_UNKNOWN, `发布网关应为 local 类型，实际为 ${config.type}`)
    }
    const file = String(config.transport.options['file'] ?? '')
    if (!file) fail(ErrorCode.RECEIPT_UNKNOWN, '发布网关没有配置回执文件路径')
    return file
  }

  /**
   * 组装一次执行。
   *
   * 后端的选择顺序：
   * 1. **显式传了计划** → 确定性规划器。回归样本必须可复现，
   *    因此它们永远不受 `datasentry.config.json` 里模型配置的影响。
   * 2. 配置了 `anthropic` → 真实模型。
   * 3. 否则 → 确定性规划器 + Skill 自带的 plan.yaml。
   */
  const makeRunner = (options: { sessionId?: string; plan?: SkillPlan }): AgentRunner => {
    const backend = pickBackend(options)
    return new AgentRunner({
      paths,
      credentials,
      sessions,
      toolCalls,
      checkpoints,
      approvals,
      events,
      guides,
      registry,
      transports: transportsById,
      loadWorkspace: loadWorkspaceFn,
      loadSkill: (name) => loadSkill(name, paths),
      loadSource: loadSourceFn,
      backend,
      saveReport: (report) => {
        reports.save(report)
      },
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(approvalTtlMs !== undefined ? { approvalTtlMs } : {}),
    })
  }

  const pickBackend = (options: { sessionId?: string; plan?: SkillPlan }): AgentBackend => {
    if (options.plan) return new MockAgentBackend(options.plan)
    if (claudeBackend) return claudeBackend
    if (openAiBackend) return openAiBackend
    if (piBackend) return piBackend
    if (!options.sessionId) return new MockAgentBackend({ steps: [] })

    const session = sessions.require(options.sessionId)
    return new MockAgentBackend(loadSkillPlan(loadSkill(session.skillName, paths)))
  }

  /**
   * 用 pi-agent-core 的循环跑一次任务。
   *
   * mock 与真实模型走**同一条循环**，区别只在 streamFn：
   * mock 用 faux 脚本（plan.yaml），真实模型用 pi-ai 的 streamSimple。
   * 这是第 2 步的核心——回归验证的就是生产要跑的那套循环。
   */
  /** pi 的流式入口，绑上本次生效的密钥与输出上限。 */
  const piStreamFn: StreamFn = (model, context, options) => {
    if (!piRuntime) throw new Error('pi 运行时未初始化')
    return piRuntime.client.streamSimple(model, context, {
      ...(options ?? {}),
      apiKey: modelCredentials.apiKey ?? undefined,
      maxTokens: modelConfig.maxTokens,
    }) as never
  }

  const runWithPiLoop = async (sessionId: string, planOverride?: SkillPlan): Promise<RunOutcome> => {
    const session = sessions.require(sessionId)
    const skill = loadSkill(session.skillName, paths)
    const plan = planOverride ?? loadSkillPlan(skill)

    // 显式传了 plan（回归样本）或 provider=mock 时走脚本化模型。
    const useMock = planOverride !== undefined || modelConfig.provider === ModelProvider.MOCK

    if (!useMock && !piRuntime) {
      fail(
        ErrorCode.MODEL_CONFIG_INVALID,
        'pi 循环需要 provider=pi（当前 provider 无法通过 pi 发起调用）',
        { provider: modelConfig.provider },
      )
    }

    const runner = new PiAgentRunner({
      paths,
      credentials,
      sessions,
      toolCalls,
      checkpoints,
      approvals,
      events,
      guides,
      registry,
      transports: transportsById,
      loadWorkspace: loadWorkspaceFn,
      loadSkill: (name) => loadSkill(name, paths),
      loadSource: loadSourceFn,
      saveReport: (report) => {
        reports.save(report)
      },
      approvalGate,
      transcripts,
      streamFn: piStreamFn,
      ...(piRuntime ? { model: piRuntime.model } : {}),
      ...(useMock ? { mockScript: createMockScript(plan, session.input, session.id) } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(approvalTtlMs !== undefined ? { approvalTtlMs } : {}),
    })

    return runner.run(sessionId)
  }

  const publishing = new PublishService({
    sessions,
    toolCalls,
    approvals,
    reports,
    events,
    loadWorkspace: loadWorkspaceFn,
    // 发起与确认发布前都要先把 Source 建起来：审批绑定的是**真实的**工具版本。
    prepare: async () => {
      await ensureSources()
    },
    toolVersionOf: (toolName) => registry.get(toolName)?.toolVersion,
    // 幂等键由网关与后端共用同一个函数算出——两边算不一样就等于没有去重。
    // 查到回执就说明这一单已经投递过，因此对调用方而言必然是「去重命中」。
    findPublishReceipt: (input) => {
      const receipt = findReceipt(publishReceiptsFile(), publishDedupeKey(input))
      return receipt ? { ...receipt, deduplicated: true } : undefined
    },
    findPublishIntent: (input) => hasPublishIntent(publishReceiptsFile(), publishDedupeKey(input)),
    // 渲染放在发起确认时：审批人要能看到自己批的是哪一份文件。
    renderReport: (report, format) => renderReportArtifact({ report, format, paths }),
    runner: async () => {
      await ensureSources()
      // 发布只是执行一条已批准的调用，不会问规划器要下一步——给空计划即可。
      return makeRunner({ plan: { steps: [] } })
    },
    ...(approvalTtlMs !== undefined ? { approvalTtlMs } : {}),
  })

  /**
   * 恢复服务放在发布服务之后构造：它要借用 `reconcilePublish` 来收尾
   * 「网关已投递、本地未记账」那个窗口。那个回调只读回执、只写本地记账，
   * 不产生任何对外动作，所以放在状态收敛里做是安全的。
   */
  const recovery = new RecoveryService({
    sessions,
    toolCalls,
    approvals,
    checkpoints,
    reports,
    events,
    reconcilePublish: async (sessionId) => {
      const result = await publishing.reconcilePublish(sessionId)
      switch (result.status) {
        case 'already-published':
          return { status: 'already-published' as const, receiptId: result.receiptId }
        case 'reconciled':
          return { status: 'reconciled' as const, receiptId: result.receipt.receiptId }
        case 'not-delivered':
          return { status: 'not-delivered' as const, reason: result.reason }
        case 'unknown':
          return { status: 'unknown' as const, reason: result.reason }
      }
    },
  })

  const decideApproval = (approvalId: string, input: DecideApprovalInput): Approval => {
    approvals.expireOverdue()
    const decided = approvals.decide(approvalId, input)
    const session = sessions.require(decided.sessionId)

    events.emit({
      sessionId: session.id,
      traceId: session.traceId,
      type: decided.status === ApprovalStatus.GRANTED ? EventType.ApprovalGranted : EventType.ApprovalDenied,
      payload: {
        approvalId: decided.id,
        kind: decided.kind,
        toolCallId: decided.toolCallId,
        toolName: decided.toolName,
        toolVersion: decided.toolVersion,
        paramsHash: decided.paramsHash,
        draftVersion: decided.draftVersion,
        recipientsHash: decided.recipientsHash,
        approver: decided.approver,
        reason: decided.reason,
        expiresAt: decided.expiresAt,
      },
    })

    /*
     * 如果 pi 循环正挂在 `beforeToolCall` 里等这条审批，就唤醒它，由钩子自己收尾
     * （它已经知道该转 FETCHING 还是 BLOCKED）。
     * 没人等待说明走的是 legacy 循环，按原有规则落状态。
     */
    const wokePiLoop = approvalGate.resolve(
      decided.id,
      decided.status === ApprovalStatus.GRANTED ? 'granted' : 'denied',
    )

    if (decided.status === ApprovalStatus.DENIED && !wokePiLoop) {
      // 被拒绝是终局：把悬挂的调用标掉，并让任务停在 BLOCKED / 回到 READY，
      // 而不是留给 Agent 换个参数再试一次。
      // 规则与重启恢复补记时走的是同一份实现，避免「重启一次就改变结局」。
      applyApprovalDenial({ sessions, toolCalls, events }, decided)
    }

    return decided
  }

  return {
    paths,
    credentials,
    database,
    auth,
    events,
    sessions,
    toolCalls,
    checkpoints,
    approvals,
    reports,
    guides,
    registry,
    managed,
    builder,
    publishing,
    recovery,
    model: {
      config: modelConfig,
      describe: () => describeModelConfig(modelConfig, modelCredentials),
    },

    ensureSources,
    transports: () => transportsById,

    loadWorkspace: loadWorkspaceFn,
    loadSource: loadSourceFn,

    createSession(input: CreateSessionInput, actor?: { userId: string }): Session {
      const workspace = loadWorkspaceFn(input.workspace)

      const skillName = input.skill ?? workspace.skills[0]
      if (!skillName) {
        fail(ErrorCode.SKILL_NOT_FOUND, `Workspace "${workspace.id}" 没有配置任何 Skill`)
      }

      const skill = loadSkill(skillName, paths)

      if (workspace.skills.length > 0 && !workspace.skills.includes(skill.name)) {
        fail(
          ErrorCode.SKILL_NOT_FOUND,
          `Workspace "${workspace.id}" 未授权使用 Skill "${skill.name}"`,
          { workspace: workspace.id, skill: skill.name, allowed: workspace.skills },
        )
      }

      /*
       * 需求文本必须能驱动执行，而不只是被记录下来。
       *
       * 真正跑几月份，由「结构化输入」与「这句需求里说的期间」共同决定；
       * 两者矛盾时报错，不替调用方选一个——否则就会出现
       * 「说的是 8 月、跑的是 6 月、而且看起来一切正常」。
       */
      const resolved = resolvePeriod({
        request: input.request,
        explicitPeriod: input.input['period'],
        timeZone: workspace.timezone,
      })
      const resolvedInput: Record<string, unknown> = { ...input.input, period: resolved.period }

      const session = sessions.create({
        workspaceId: workspace.id,
        createdBy: actor?.userId ?? null,
        skillName: skill.name,
        // 固定 Skill 版本：运行中 Skill 改动不影响本次任务（FR-02.4）。
        skillVersion: skill.version,
        request: input.request,
        input: resolvedInput,
      })

      events.emit({
        sessionId: session.id,
        traceId: session.traceId,
        type: EventType.SessionCreated,
        payload: {
          workspaceId: workspace.id,
          skill: skill.name,
          skillVersion: skill.version,
          request: input.request,
          input: resolvedInput,
          inputVersion: session.inputVersion,
          permissionMode: workspace.defaultPermissionMode,
          /** `explicit` = 调用方给了 period；`parsed` = 从这句需求里识别出来的。 */
          periodSource: resolved.source,
          period: resolved.period,
        },
      })

      return session
    },

    async runSession(sessionId: string, options: { plan?: SkillPlan } = {}): Promise<RunOutcome> {
      await ensureSources()

      if (agentLoop === 'pi') {
        return runWithPiLoop(sessionId, options.plan)
      }

      // 不在这里把 Skill 计划取出来：不传计划时由后端选择决定用确定性规划器还是真实模型。
      return makeRunner({ sessionId, ...(options.plan ? { plan: options.plan } : {}) }).run(sessionId)
    },

    decideApproval,

    async resumeSession(
      sessionId: string,
      options: { plan?: SkillPlan } = {},
    ): Promise<RunOutcome> {
      await ensureSources()

      // pi 循环下，恢复也走同一个 runner：它检测到 WAITING_APPROVAL 就会
      // 从持久化的对话记录接着跑。
      if (agentLoop === 'pi') {
        return runWithPiLoop(sessionId, options.plan)
      }

      return makeRunner({ sessionId, ...(options.plan ? { plan: options.plan } : {}) }).run(sessionId)
    },

    resolveManualReview(
      sessionId: string,
      input: ManualReviewInput,
      actor?: { userId?: string; displayName?: string },
    ): Session {
      const session = sessions.require(sessionId)
      if (session.state !== SessionState.MANUAL_REVIEW) {
        fail(
          ErrorCode.ILLEGAL_STATE_TRANSITION,
          `Session ${sessionId} 当前状态为 ${session.state}，只有 MANUAL_REVIEW 可以人工处置`,
          { sessionId, state: session.state },
        )
      }

      /*
       * 离开 MANUAL_REVIEW 之前先把现场收干净：
       * - 悬挂调用标记为中断，恢复/重试不会重放一个结果未知的调用；
       * - 所有未决审批吊销，关闭后的任务不能再被「确认投递」。
       */
      for (const call of toolCalls.pendingBySession(sessionId)) {
        toolCalls.finish(call.id, 'denied', {
          denyCode: ErrorCode.EXECUTION_INTERRUPTED,
          denyReason: `人工复核处置：${input.reason}`,
        })
        events.emit({
          sessionId,
          traceId: session.traceId,
          type: EventType.ToolCallFailed,
          payload: {
            toolCallId: call.id,
            toolName: call.toolName,
            status: 'denied',
            code: ErrorCode.EXECUTION_INTERRUPTED,
            reason: `人工复核处置：${input.reason}`,
          },
        })
      }
      approvals.revokeAll(sessionId)

      let to: SessionState
      let errorCode: string | null = null
      let errorMessage: string | null = null
      let reportConfirmed = false
      switch (input.resolution) {
        case 'retry':
          // PAUSED 是恢复入口的起点；这里不自动执行，避免接口长时间阻塞。
          to = SessionState.PAUSED
          errorMessage = `人工复核要求重试：${input.reason}`
          break
        case 'accept': {
          const report = reports.bySession(sessionId)
          if (!report || report.status === 'failed') {
            fail(
              ErrorCode.VALIDATION_FAILED,
              '没有可接受的报表产物；请选择 fail 或 block',
              { sessionId },
            )
          }
          // 接受草稿意味着它不再是「待发布草稿」；标记 confirmed，
          // 避免详情页继续显示一个点了必然失败的「发起发布」。
          if (report.status === 'draft') {
            reports.patch(report.id, { status: 'confirmed' })
            reportConfirmed = true
          }
          to = SessionState.DONE
          break
        }
        case 'fail':
          to = SessionState.FAILED
          errorCode = ErrorCode.MANUAL_REVIEW_FAILED
          errorMessage = input.reason
          break
        case 'block':
          to = SessionState.BLOCKED
          errorCode = ErrorCode.MANUAL_REVIEW_BLOCKED
          errorMessage = input.reason
          break
      }

      const updated = sessions.transition(session.id, session.stateVersion, to, {
        errorCode,
        errorMessage,
      })
      events.emit({
        sessionId: updated.id,
        traceId: updated.traceId,
        type: EventType.StateChanged,
        payload: {
          from: SessionState.MANUAL_REVIEW,
          to,
          reason: `manual-review:${input.resolution}`,
          detail: input.reason,
          actorId: actor?.userId ?? null,
          actorName: actor?.displayName ?? null,
          reportConfirmed,
        },
      })
      return updated
    },

    requestPublish: (reportId, request) => publishing.requestPublish(reportId, request),
    confirmPublish: async (approvalId) => {
      await ensureSources()
      return publishing.confirmPublish(approvalId)
    },
    reconcilePublish: async (sessionId) => {
      await ensureSources()
      return publishing.reconcilePublish(sessionId)
    },
    publishReceipts: (reportId) => receiptsForReport(publishReceiptsFile(), reportId),
    allPublishReceipts: () => readReceipts(publishReceiptsFile()),

    async runRecovery(options = {}): Promise<RecoveryResult> {
      if (options.execute === true) await ensureSources()
      return recovery.recover({
        execute: options.execute === true,
        ...(options.sessionIds !== undefined ? { sessionIds: options.sessionIds } : {}),
        // 恢复执行走的是与手工恢复相同的路径：重放原 ToolCall、不重新规划。
        // WAITING_APPROVAL 用 pi 自己的恢复（读 transcript、不重新规划）；
        // PAUSED 交给 legacy 的检查点恢复——pi 循环目前没有等价的 PAUSED 恢复。
        // 还要确认 transcript 确实是 pi 写的：legacy 创建的会话没有这份记录，
        // 误交给 pi 会因为「找不到挂起调用」而永远恢复不了。
        resume: async (sessionId) => {
          const session = sessions.require(sessionId)
          const usePi =
            agentLoop === 'pi' &&
            session.state === SessionState.WAITING_APPROVAL &&
            transcripts.read(sessionId).length > 0
          const outcome = usePi
            ? await runWithPiLoop(sessionId, options.plan)
            : await makeRunner({
                sessionId,
                ...(options.plan ? { plan: options.plan } : {}),
              }).run(sessionId)
          return {
            state: outcome.state,
            errorCode: outcome.errorCode,
            resultCount: outcome.results.length,
          }
        },
      })
    },
    async close() {
      if (built) await built.close()
      else await managed.closeAll()
      database.close()
    },
  }
}
