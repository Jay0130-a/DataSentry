/**
 * AgentEvent 事件轨迹定义（PRD FR-05 / §8 审计）。
 *
 * 事件是审计与回归的唯一事实来源：每次工具调用、权限判定、审批、发布都必须落一条。
 * 事件写入 SQLite（结构化查询）与 JSONL（追加式轨迹、可被回归脚本直接读取）两份。
 */
export const EventType = {
  SessionCreated: 'session.created',
  SkillLoaded: 'skill.loaded',
  SourceActivated: 'source.activated',
  PlanningCompleted: 'planning.completed',
  GuideRead: 'guide.read',
  ToolCallRequested: 'tool.call.requested',
  PermissionDecided: 'permission.decided',
  ToolCallCompleted: 'tool.call.completed',
  ToolCallFailed: 'tool.call.failed',
  StateChanged: 'session.state.changed',
  CheckpointSaved: 'checkpoint.saved',
  MetricComputed: 'metric.computed',
  ValidationFailed: 'validation.failed',
  ReportDrafted: 'report.drafted',
  SessionCompleted: 'session.completed',

  // —— M2：审批
  ApprovalRequested: 'approval.requested',
  ApprovalGranted: 'approval.granted',
  ApprovalDenied: 'approval.denied',

  // —— M4：发布与回执
  PublishConfirmationRequested: 'publish.confirmation.requested',
  PublishExecuted: 'publish.executed',
  ReceiptReceived: 'receipt.received',
  /** 结果未知时查回执并补齐记账（进程在投递与落库之间挂掉的收尾）。 */
  PublishReconciled: 'publish.reconciled',
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]

export const ALL_EVENT_TYPES: readonly EventType[] = Object.values(EventType)

/**
 * 一条事件轨迹记录。`seq` 在单个 session 内单调递增，回归脚本按它定位首个异常步骤。
 */
export interface AgentEvent<P = Record<string, unknown>> {
  eventId: string
  sessionId: string
  traceId: string
  seq: number
  type: EventType
  /** ISO-8601 UTC 时间戳 */
  at: string
  payload: P
}

export const JSONL_EXT = '.jsonl'

export function serializeEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`
}

/** 解析 JSONL 轨迹；空行跳过，坏行带行号报错而不是静默丢弃。 */
export function parseEventJsonl(text: string): AgentEvent[] {
  const events: AgentEvent[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line) as AgentEvent)
    } catch (err) {
      throw new Error(
        `事件轨迹第 ${i + 1} 行不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return events
}
