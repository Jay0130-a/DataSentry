import { z } from 'zod'

/** 计划步骤（与 `skills/<name>/plan.yaml` 同构，用于样本内联覆盖）。 */
export const caseStepSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  description: z.string().optional(),
})

/**
 * 流程动作。
 *
 * 一个样本就是一段可读的剧本：跑任务、批审批、恢复、发起发布、确认发布。
 * 审批与发布引入之后，单次 `run` 已经不足以描述一条完整路径——
 * 「审批等待期间任务停下、批准之后从原处继续」本身就是被测对象。
 */
export const flowActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run') }),

  z.object({
    action: z.literal('decide'),
    /** 审批句柄：`pending` 表示该 Session 上最近一条待审批项。 */
    approval: z.string().default('pending'),
    decision: z.enum(['granted', 'denied']),
    approver: z.string().min(1),
    reason: z.string().optional(),
  }),

  z.object({ action: z.literal('resume') }),

  /**
   * 模拟服务重启：关掉当前 AppContext，在**同一份数据目录**上重新起一个。
   *
   * 进程内的一切（内存缓存、MCP 子进程、guide 已读状态）都会丢失，
   * 只剩 SQLite 与磁盘文件——这正是「重启恢复」要验证的东西。
   */
  z.object({ action: z.literal('restart') }),

  /** 启动后的恢复核对；`execute` 为 true 时连执行一起做。 */
  z.object({
    action: z.literal('recover'),
    execute: z.boolean().default(false),
  }),

  z.object({
    action: z.literal('request-publish'),
    /** 给这次发布请求起个名字，供后面的 decide / confirm-publish 引用。 */
    id: z.string().default('publish'),
    recipients: z.array(z.string().min(1)).min(1),
    channel: z.enum(['email', 'im', 'portal']).default('email'),
    /** 发布格式，会进审批绑定。 */
    format: z.enum(['xlsx', 'docx', 'pdf', 'md']).default('xlsx'),
  }),

  z.object({
    action: z.literal('confirm-publish'),
    approval: z.string().default('pending'),
  }),

  /**
   * 篡改悬挂调用的参数，但**不动**它的参数摘要。
   *
   * 这是审批绑定最刁钻的绕过方式：绑定比对的是记录里的 `params_hash`，
   * 而执行用的是 `args`。只改后者，绑定看上去仍然匹配。
   * 这个动作就是把这个攻击路径写进回归——它验证的是「摘要必须由参数现算」。
   */
  z.object({ action: z.literal('tamper-params') }),

  /**
   * 把一条审批的有效期拨到过去。
   *
   * 用来构造「已经批准、但恢复时已过期」：决定与过期之间的时间窗口在真实系统里
   * 客观存在（审批可能跨天），恢复路径必须重新核对有效期，而不是只看状态字段。
   */
  z.object({
    action: z.literal('expire-approval'),
    /** 审批句柄；`latest` 表示该 Session 最近一条审批（不论当前状态）。 */
    approval: z.string().default('latest'),
  }),

  /**
   * 精确复现「网关已投递、进程在记账之前挂掉」那个窗口。
   *
   * 做法是把记账回退到投递前的样子（报表回 draft、会话回 WAITING_APPROVAL），
   * 但**保留网关侧的回执**。正常代码路径走不到这个状态——DONE 不允许回到
   * WAITING_APPROVAL——所以只能直接改库，这也正是「进程崩溃」的语义。
   */
  z.object({ action: z.literal('simulate-interrupted-publish') }),
])

export type FlowAction = z.infer<typeof flowActionSchema>
export type EvalCaseStep = z.infer<typeof caseStepSchema>

/**
 * 回归样本（PRD FR-05.2）。
 *
 * 每个样本固定输入、配置版本与期望事件序列。`steps` 可选：
 * 写了就替换 Skill 自带的 plan.yaml，用来构造「跳过 guide」「非法参数」
 * 「跨 Workspace」这类违规路径，而不必为每种违规单独建一个 Skill 目录。
 */
export const evalCaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /**
   * 这个样本对应 PRD FR-05.1 要求的哪一类路径。
   * 回归报告按它统计「8-10 类路径」的覆盖情况。
   */
  path: z.string().min(1),
  /** 这个样本在验证 PRD 的哪条验收标准，便于报告直接对应回文档。 */
  covers: z.array(z.string()).default([]),
  /**
   * 该样本适用于哪套循环。
   *
   * `approval-params-drift-rejected` 只对 legacy 有意义：hook 内 await 时
   * 参数就在内存里，不存在「恢复时重读被改过的参数」这条路径。
   */
  runners: z.array(z.enum(['legacy', 'pi'])).default(['legacy', 'pi']),
  workspace: z.string().min(1),
  skill: z.string().optional(),
  request: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  steps: z.array(caseStepSchema).optional(),
  /** 流程剧本；省略等同于只跑一次 `run`。 */
  flow: z.array(flowActionSchema).default([{ action: 'run' }]),
  /**
   * 是否写入开发凭据。设成 false 用来构造「凭据缺失」路径——
   * 需要凭据的 Source 会以 `CREDENTIAL_MISSING` 失败，而不是拿空字符串继续跑。
   */
  credentials: z.boolean().default(true),
  /**
   * 需要预置的真实数据源。目前只有 `reporting-db`：
   * 样本会在自己的临时目录里建一个 PGlite 库并写入种子数据。
   */
  seed: z.array(z.enum(['reporting-db'])).default([]),

  expect: z.object({
    /** 期望的终止状态。 */
    state: z.string().min(1),
    /** 期望的 Session 错误码。 */
    errorCode: z.string().nullable().default(null),
    /** 期望某个动作抛出的错误码（比如确认发布时发现绑定已失效）。 */
    actionError: z.string().nullable().default(null),
    /** 期望被拦在第几个工具上。 */
    stoppedAtTool: z.string().nullable().default(null),
    /**
     * 期望的事件序列。按**有序子序列**匹配——实际轨迹里允许穿插其它事件
     * （比如每次状态变更、每个检查点），但期望的顺序不能被打破。
     */
    events: z.array(z.string()).min(1),
    /** 期望产出报表里包含的指标 key。 */
    metricsPresent: z.array(z.string()).default([]),
    /** 期望的取数结果条数。 */
    resultCount: z.number().int().min(0).optional(),
    /** 期望的报表状态；`null` 表示不产出报表。 */
    reportStatus: z.enum(['draft', 'confirmed', 'published', 'failed']).nullable().default(null),
    /** 期望产生的审批条数。 */
    approvalCount: z.number().int().min(0).optional(),
    /** 期望恢复扫描对本次任务给出的结论（`RecoveryAction`）。 */
    recoveryAction: z.string().nullable().default(null),
    /**
     * 断言没有重复的工具调用（同一工具 + 同一参数只调用一次）。
     *
     * 这是「已完成步骤不重放」最直接的观测点：如果恢复时从头再跑一遍，
     * 前面那些取数就会以完全相同的参数再出现一次。
     */
    noDuplicateToolCalls: z.boolean().default(false),
    /** 期望报表注脚里出现这些片段（比如完整性告警）。 */
    warningsContaining: z.array(z.string()).default([]),
    /** 期望网关里留下的回执条数——用来断言「没有重发」。 */
    receiptCount: z.number().int().min(0).optional(),
  }),
})

export type EvalCase = z.infer<typeof evalCaseSchema>
