import { z } from 'zod'
import { isoTimestamp, jsonObject, toolCallStatusSchema, type Completeness } from './common.ts'
import { SessionState } from '../state.ts'

export const sessionStateSchema = z.enum(SessionState)

/**
 * session：单次任务状态（PRD §7 / FR-04）。
 *
 * `stateVersion` 是乐观锁：每次状态更新都 `WHERE state_version = ?` 并 +1。
 * 没有它，重启后残留的旧执行器会覆盖新状态，恢复就变成了数据竞争。
 */
export const sessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /**
   * 发起人（登录账号 ID）。
   *
   * `null` 只出现在两种场景：迁移前的历史数据，以及 CLI/回归直接发起的任务。
   * 可见性按 **Workspace** 判定（审批人必须能打开别人发起的任务），
   * 发起人用于审计与展示，不参与鉴权。
   */
  createdBy: z.string().nullable().default(null),
  state: sessionStateSchema,
  /** 当前步骤序号，与 checkpoint.step 对应。 */
  step: z.number().int().min(0),
  stateVersion: z.number().int().min(0),
  /** 固定住的 Skill 版本；运行中 Skill 改动不影响本次任务。 */
  skillVersion: z.string().min(1),
  /** 输入版本：请求 + 周期 + 参数摘要，用于判断检查点是否还匹配当前输入。 */
  inputVersion: z.string().min(1),
  traceId: z.string().min(1),
  skillName: z.string().min(1),
  /** 用户原始自然语言需求。 */
  request: z.string().min(1),
  /** 结构化输入（周期、部门等）。 */
  input: jsonObject,
  errorCode: z.string().nullable().default(null),
  errorMessage: z.string().nullable().default(null),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})

export type Session = z.infer<typeof sessionSchema>

export const DEFAULT_SESSION_STATE: SessionState = SessionState.INIT

/** 创建 Session 所需的输入。 */
export const createSessionInputSchema = z.object({
  workspace: z.string().min(1),
  request: z.string().min(1),
  input: jsonObject.default({}),
  skill: z.string().min(1).optional(),
})

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>

/**
 * `MANUAL_REVIEW` 的人工处置。
 *
 * - `retry`：回到 PAUSED，由恢复/执行入口从检查点继续
 * - `accept`：接受当前报表产物，直接结清为 DONE
 * - `fail`：确认任务失败
 * - `block`：保留现场，转 BLOCKED 等进一步处理
 */
export const manualReviewResolutionSchema = z.enum(['retry', 'accept', 'fail', 'block'])

export const manualReviewInputSchema = z.object({
  resolution: manualReviewResolutionSchema,
  /** 人工判断的依据；审计轨迹会原样记录。 */
  reason: z.string().trim().min(1),
})

export type ManualReviewResolution = z.infer<typeof manualReviewResolutionSchema>
export type ManualReviewInput = z.infer<typeof manualReviewInputSchema>

/** tool_call：一次工具调用的记录（PRD §7）。 */
export const toolCallSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  /**
   * 该调用在 Session 内的序号，单调递增。
   *
   * 恢复时要靠它把已完成的调用按原顺序还原成 Agent 的记忆——
   * `created_at` 只有毫秒精度，同一毫秒内发起的多次调用会打乱顺序。
   */
  step: z.number().int().min(0),
  toolName: z.string().min(1),
  sourceSlug: z.string().min(1),
  /** 参数规范化摘要。审批绑定与「参数漂移导致审批失效」都靠它。 */
  paramsHash: z.string().min(1),
  /** 工具版本（Source config + guide 摘要），审批需绑定。 */
  toolVersion: z.string().min(1),
  status: toolCallStatusSchema,
  args: jsonObject,
  resultRef: z.string().nullable().default(null),
  /** 被拒绝时的错误码。 */
  denyCode: z.string().nullable().default(null),
  denyReason: z.string().nullable().default(null),
  createdAt: isoTimestamp,
  finishedAt: isoTimestamp.nullable().default(null),
})

export type ToolCall = z.infer<typeof toolCallSchema>

/** checkpoint：每个安全步骤的检查点（PRD §7 / FR-04.2）。 */
export const checkpointSchema = z.object({
  sessionId: z.string().min(1),
  step: z.number().int().min(0),
  stateVersion: z.number().int().min(0),
  inputVersion: z.string().min(1),
  outputRef: z.string().nullable().default(null),
  approvalRef: z.string().nullable().default(null),
  state: sessionStateSchema,
  createdAt: isoTimestamp,
})

export type Checkpoint = z.infer<typeof checkpointSchema>

/** 取数结果信封（PRD FR-01.4）：resultId / sourceRef / dataVersion / completeness 四件套。 */
export const toolResultSchema = z.object({
  resultId: z.string().min(1),
  toolName: z.string().min(1),
  sourceRef: z.object({
    slug: z.string().min(1),
    tool: z.string().min(1),
    /** 数据侧版本，用于报表标注「数据版本」并检测口径漂移。 */
    dataVersion: z.string().min(1),
  }),
  completeness: z.enum(['full', 'partial', 'unknown']),
  data: z.unknown(),
  meta: jsonObject.default({}),
})

export type ToolResult = z.infer<typeof toolResultSchema>

/**
 * 一次工具执行的**载荷**（Source 侧返回值），信封由后端补齐后成为 `ToolResult`。
 *
 * `meta` 是 Source 与后端之间的契约：数据版本、完整性、行数。
 * 敏感 Source 只回形状不回内容——事件轨迹落的就是这份 meta。
 */
export interface ToolExecution {
  data: unknown
  meta: {
    /** 结果的数据侧版本，报表据此声明「基于哪一版数据」。 */
    dataVersion: string
    completeness: Completeness
    rowCount: number
    [key: string]: unknown
  }
}
