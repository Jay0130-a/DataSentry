import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode, isDataSentryError, SessionState } from '@datasentry/core'
import { openDatabase, type DatabaseHandle } from '@datasentry/backend/db/index.ts'
import { SessionStore } from '@datasentry/backend/runtime/session-store.ts'
import { CheckpointStore } from '@datasentry/backend/runtime/checkpoint.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let handle: DatabaseHandle
let store: SessionStore

function setup(): void {
  temp = tempPaths()
  handle = openDatabase(temp.paths)
  store = new SessionStore(handle.db)
}

afterEach(() => {
  handle?.close()
  temp?.cleanup()
})

describe('Session 状态库', () => {
  it('新会话从 INIT 开始，版本号为 0', () => {
    setup()
    const session = store.create({
      workspaceId: 'group-finance',
      skillName: 'skill',
      skillVersion: 'v1',
      request: '出月报',
      input: { period: '2025-09' },
    })
    expect(session.state).toBe(SessionState.INIT)
    expect(session.stateVersion).toBe(0)
    expect(session.inputVersion).toMatch(/^[0-9a-f]{16}$/)
  })

  it('相同的输入得到相同的 inputVersion，改一个字段就变', () => {
    setup()
    const base = {
      workspaceId: 'w',
      skillName: 's',
      skillVersion: 'v1',
      request: 'r',
    }
    const a = store.create({ ...base, input: { period: '2025-09' } })
    const b = store.create({ ...base, input: { period: '2025-09' } })
    const c = store.create({ ...base, input: { period: '2025-10' } })

    expect(a.inputVersion).toBe(b.inputVersion)
    expect(a.inputVersion).not.toBe(c.inputVersion)
  })

  it('合法转移成功并推进版本号', () => {
    setup()
    const session = store.create({
      workspaceId: 'w',
      skillName: 's',
      skillVersion: 'v1',
      request: 'r',
      input: {},
    })
    const planning = store.transition(session.id, 0, SessionState.PLANNING)
    expect(planning.state).toBe(SessionState.PLANNING)
    expect(planning.stateVersion).toBe(1)
  })

  it('非法转移被拒绝，且状态没有被改动', () => {
    setup()
    const session = store.create({
      workspaceId: 'w',
      skillName: 's',
      skillVersion: 'v1',
      request: 'r',
      input: {},
    })
    expect(() => store.transition(session.id, 0, SessionState.READY)).toThrowError(
      /非法状态转移/,
    )
    expect(store.require(session.id).state).toBe(SessionState.INIT)
  })

  it('用过期版本号写入会失败——这是「旧执行器不覆盖新状态」的保障', () => {
    setup()
    const session = store.create({
      workspaceId: 'w',
      skillName: 's',
      skillVersion: 'v1',
      request: 'r',
      input: {},
    })

    // 执行器 A 先推进到 PLANNING（版本 1）
    store.transition(session.id, 0, SessionState.PLANNING)

    // 执行器 B 手里还拿着版本 0，它必须失败
    try {
      store.transition(session.id, 0, SessionState.FETCHING)
      throw new Error('本应抛出 STATE_VERSION_CONFLICT')
    } catch (err) {
      expect(isDataSentryError(err)).toBe(true)
      if (isDataSentryError(err)) expect(err.code).toBe(ErrorCode.STATE_VERSION_CONFLICT)
    }

    expect(store.require(session.id).state).toBe(SessionState.PLANNING)
  })

  it('bumpStep 同样受版本号保护', () => {
    setup()
    const session = store.create({
      workspaceId: 'w',
      skillName: 's',
      skillVersion: 'v1',
      request: 'r',
      input: {},
    })
    const stepped = store.bumpStep(session.id, 0)
    expect(stepped.step).toBe(1)
    expect(() => store.bumpStep(session.id, 0)).toThrowError(/状态版本已变化/)
  })
})

describe('检查点', () => {
  it('同一步骤重复保存是 upsert，不会留下两条互相矛盾的记录', () => {
    setup()
    const checkpoints = new CheckpointStore(handle.db)
    const session = store.create({
      workspaceId: 'w',
      skillName: 's',
      skillVersion: 'v1',
      request: 'r',
      input: {},
    })

    checkpoints.save({
      sessionId: session.id,
      step: 1,
      stateVersion: 1,
      inputVersion: session.inputVersion,
      state: SessionState.FETCHING,
      outputRef: 'out-1',
    })
    checkpoints.save({
      sessionId: session.id,
      step: 1,
      stateVersion: 2,
      inputVersion: session.inputVersion,
      state: SessionState.FETCHING,
      outputRef: 'out-2',
    })

    const list = checkpoints.list(session.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.outputRef).toBe('out-2')
    expect(checkpoints.latest(session.id)?.stateVersion).toBe(2)
  })

  it('latest 返回步号最大的检查点（M3 的恢复入口）', () => {
    setup()
    const checkpoints = new CheckpointStore(handle.db)
    const session = store.create({
      workspaceId: 'w',
      skillName: 's',
      skillVersion: 'v1',
      request: 'r',
      input: {},
    })
    for (const step of [3, 1, 2]) {
      checkpoints.save({
        sessionId: session.id,
        step,
        stateVersion: step,
        inputVersion: session.inputVersion,
        state: SessionState.FETCHING,
        outputRef: `out-${step}`,
      })
    }
    expect(checkpoints.latest(session.id)?.step).toBe(3)
    expect(checkpoints.list(session.id).map((c) => c.step)).toEqual([1, 2, 3])
  })
})
