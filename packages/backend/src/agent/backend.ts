import type { ToolResult } from '@datasentry/core'

/** 提供给规划器的一个工具描述。 */
export interface AgentToolDescriptor {
  name: string
  title: string
  description: string
  paramsSchema: Record<string, unknown>
  /** 该工具所属 Source 的 guide 是否已在本次 Session 读过。 */
  guideRead: boolean
}

/** 已经发生的一步。历史是规划器的唯一记忆。 */
export interface AgentStepRecord {
  step: number
  toolName: string
  args: Record<string, unknown>
  status: 'succeeded' | 'denied' | 'failed'
  /** 成功时的取数结果（Source 工具）。内置工具没有这个。 */
  result?: ToolResult
  /**
   * 内置工具返回给模型看的文本（比如 guide 内容）。
   *
   * 与 `result` 分开是因为语义不同：`result` 是「取数结果」，
   * 会进指标计算与口径核对；`note` 只是「工具说了什么」，不参与计算。
   * 早先没有这个字段，导致成功的 guide 读取被渲染成「调用未成功」——
   * 模型以为全挂了，直接放弃。
   */
  note?: string
  errorCode?: string
  errorMessage?: string
}

export interface AgentContext {
  sessionId: string
  workspaceId: string
  request: string
  input: Record<string, unknown>
  skill: {
    name: string
    description: string
    body: string
    requiredSources: readonly string[]
    stopRules: readonly string[]
  }
  /** 本次可用的工具（已经是注册表里的全部，能不能调用由 PreToolUse 决定）。 */
  tools: readonly AgentToolDescriptor[]
  /** 已激活的 Source。 */
  activeSourceSlugs: readonly string[]
  history: readonly AgentStepRecord[]
}

export interface AgentToolCall {
  name: string
  args: Record<string, unknown>
}

export type AgentAction =
  | { type: 'tool_calls'; calls: AgentToolCall[]; rationale?: string }
  | { type: 'finish'; summary: string }

/**
 * Agent 后端抽象（PRD §9）。
 *
 * 只暴露一个方法：给定上下文，给出下一步动作。M1 的实现是确定性脚本规划器；
 * 接 Claude / OpenAI-compatible 时换一个实现即可，Agent Loop、权限链、
 * 状态机、事件轨迹全都不用动。
 */
export interface AgentBackend {
  readonly name: string
  nextAction(ctx: AgentContext): Promise<AgentAction>
}
