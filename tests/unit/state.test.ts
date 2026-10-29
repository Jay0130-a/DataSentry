import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  isTerminal,
  nextStates,
  SessionState,
} from '@datasentry/core'

describe('Session 状态机', () => {
  it('正常链路可以逐步推进', () => {
    const normal = [
      SessionState.INIT,
      SessionState.PLANNING,
      SessionState.FETCHING,
      SessionState.COMPUTING,
      SessionState.VALIDATING,
      SessionState.READY,
    ]
    for (let i = 0; i < normal.length - 1; i += 1) {
      expect(canTransition(normal[i]!, normal[i + 1]!), `${normal[i]} → ${normal[i + 1]}`).toBe(true)
    }
  })

  it('FETCHING 允许自转移（一次任务多次取数）', () => {
    expect(canTransition(SessionState.FETCHING, SessionState.FETCHING)).toBe(true)
  })

  it('不能从 FETCHING 直接跳到 READY', () => {
    expect(canTransition(SessionState.FETCHING, SessionState.READY)).toBe(false)
    expect(() => assertTransition(SessionState.FETCHING, SessionState.READY)).toThrowError(
      /非法状态转移/,
    )
  })

  it('WAITING_APPROVAL 可以回到业务阶段，也可以转异常分支', () => {
    expect(nextStates(SessionState.WAITING_APPROVAL)).toEqual([
      // 取数审批通过后回 FETCHING 接着取数；发布确认通过后回 READY 再发布
      SessionState.FETCHING,
      SessionState.READY,
      SessionState.DONE,
      SessionState.PAUSED,
      SessionState.BLOCKED,
      SessionState.MANUAL_REVIEW,
      SessionState.FAILED,
    ])
  })

  it('READY 不能直接跳到 DONE 之外的地方，也不能绕过 WAITING_APPROVAL 去发布', () => {
    expect(canTransition(SessionState.READY, SessionState.DONE)).toBe(true)
    expect(canTransition(SessionState.READY, SessionState.WAITING_APPROVAL)).toBe(true)
    expect(canTransition(SessionState.READY, SessionState.FETCHING)).toBe(false)
    expect(canTransition(SessionState.READY, SessionState.MANUAL_REVIEW)).toBe(false)
  })

  it('终态不再有出边', () => {
    for (const terminal of [SessionState.DONE, SessionState.FAILED]) {
      expect(nextStates(terminal)).toEqual([])
      expect(isTerminal(terminal)).toBe(true)
    }
    expect(isTerminal(SessionState.READY)).toBe(false)
    expect(isTerminal(SessionState.BLOCKED)).toBe(true)
  })

  it('BLOCKED 可以被人工推进，但不能自行回到 FETCHING', () => {
    expect(canTransition(SessionState.BLOCKED, SessionState.MANUAL_REVIEW)).toBe(true)
    expect(canTransition(SessionState.BLOCKED, SessionState.FETCHING)).toBe(false)
  })

  it('每个状态都在转移表里有定义', () => {
    for (const state of Object.values(SessionState)) {
      expect(() => nextStates(state)).not.toThrow()
    }
  })
})
