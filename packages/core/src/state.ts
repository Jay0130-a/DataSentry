import { ErrorCode, fail } from './errors.ts'

/**
 * Session 状态机（PRD FR-04）。
 *
 * 正常链路：INIT → PLANNING → FETCHING → COMPUTING → VALIDATING → READY → DONE
 * 异常分支：PAUSED / BLOCKED / MANUAL_REVIEW / FAILED
 *
 * 状态转移是硬约束——任何组件都不得直接写 session.state，必须经过 assertTransition，
 * 否则「任务长但不失控」就退化成了一句 Prompt。
 */
export const SessionState = {
  INIT: 'INIT',
  PLANNING: 'PLANNING',
  FETCHING: 'FETCHING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  COMPUTING: 'COMPUTING',
  VALIDATING: 'VALIDATING',
  READY: 'READY',
  DONE: 'DONE',
  PAUSED: 'PAUSED',
  BLOCKED: 'BLOCKED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  FAILED: 'FAILED',
} as const

export type SessionState = (typeof SessionState)[keyof typeof SessionState]

export const ALL_SESSION_STATES: readonly SessionState[] = Object.values(SessionState)

/** 到达这些状态后任务不再自行推进。 */
export const TERMINAL_STATES: readonly SessionState[] = [
  SessionState.DONE,
  SessionState.FAILED,
  SessionState.BLOCKED,
]

/** 这些状态可以从中断处恢复执行。 */
export const RESUMABLE_STATES: readonly SessionState[] = [
  SessionState.PAUSED,
  SessionState.WAITING_APPROVAL,
  SessionState.MANUAL_REVIEW,
]

const TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  [SessionState.INIT]: [SessionState.PLANNING, SessionState.FAILED, SessionState.BLOCKED],
  [SessionState.PLANNING]: [
    SessionState.FETCHING,
    SessionState.PAUSED,
    SessionState.FAILED,
    SessionState.BLOCKED,
  ],
  // FETCHING 允许自转移：一次任务里会有多次取数调用。
  [SessionState.FETCHING]: [
    SessionState.FETCHING,
    SessionState.WAITING_APPROVAL,
    SessionState.COMPUTING,
    SessionState.PAUSED,
    SessionState.FAILED,
    SessionState.BLOCKED,
  ],
  /**
   * 审批通过后回到业务阶段：取数审批回 FETCHING，发布确认回 READY。
   * 被拒绝则进 BLOCKED，等人工决定，而不是让 Agent 换个参数再试。
   */
  [SessionState.WAITING_APPROVAL]: [
    SessionState.FETCHING,
    SessionState.READY,
    SessionState.DONE,
    SessionState.PAUSED,
    SessionState.BLOCKED,
    SessionState.MANUAL_REVIEW,
    SessionState.FAILED,
  ],
  [SessionState.COMPUTING]: [
    SessionState.VALIDATING,
    SessionState.PAUSED,
    SessionState.FAILED,
    SessionState.BLOCKED,
  ],
  [SessionState.VALIDATING]: [
    SessionState.READY,
    SessionState.MANUAL_REVIEW,
    SessionState.PAUSED,
    SessionState.FAILED,
  ],
  [SessionState.READY]: [
    SessionState.WAITING_APPROVAL, // 发布二次确认
    SessionState.COMPUTING, // 重算指标
    SessionState.DONE, // 发布完成
    SessionState.PAUSED,
    SessionState.FAILED,
  ],
  [SessionState.PAUSED]: [
    SessionState.PLANNING,
    SessionState.FETCHING,
    SessionState.WAITING_APPROVAL,
    SessionState.COMPUTING,
    SessionState.VALIDATING,
    SessionState.READY,
    SessionState.FAILED,
    SessionState.BLOCKED,
  ],
  [SessionState.BLOCKED]: [
    SessionState.MANUAL_REVIEW,
    SessionState.FAILED,
    SessionState.PAUSED,
  ],
  [SessionState.MANUAL_REVIEW]: [
    SessionState.PAUSED,
    SessionState.READY,
    SessionState.DONE,
    SessionState.BLOCKED,
    SessionState.FAILED,
  ],
  [SessionState.DONE]: [],
  [SessionState.FAILED]: [],
}

export function nextStates(from: SessionState): readonly SessionState[] {
  return TRANSITIONS[from]
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 非法转移直接抛错，不给「悄悄写坏状态」留口子。 */
export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) {
    fail(ErrorCode.ILLEGAL_STATE_TRANSITION, `非法状态转移：${from} → ${to}`, {
      from,
      to,
      allowed: TRANSITIONS[from],
    })
  }
}

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state)
}
