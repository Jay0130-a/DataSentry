import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { EventType } from '@datasentry/core'
import { openDatabase, type DatabaseHandle } from '@datasentry/backend/db/index.ts'
import { EventStore } from '@datasentry/backend/events/event-store.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let handle: DatabaseHandle

afterEach(() => {
  handle?.close()
  temp?.cleanup()
  vi.restoreAllMocks()
})

function setup(): EventStore {
  temp = tempPaths('datasentry-events-')
  handle = openDatabase(temp.paths)
  return new EventStore(handle.db, temp.paths, undefined, handle.sqlite)
}

function emit(store: EventStore, sessionId = 'sess_test') {
  return store.emit({
    sessionId,
    traceId: 'trace_1',
    type: EventType.SessionCreated,
    payload: { note: 'x' },
  })
}

/** 把事件目录换成一个同名文件，让 appendFileSync 必然失败（ENOTDIR）。 */
function blockJsonlDir(): void {
  rmSync(temp.paths.events, { recursive: true, force: true })
  writeFileSync(temp.paths.events, 'blocked', 'utf8')
}

function unblockJsonlDir(): void {
  rmSync(temp.paths.events, { force: true })
}

describe('事件轨迹：库是事实源，JSONL 是导出', () => {
  it('正常情况两边都写', () => {
    const store = setup()
    emit(store)

    expect(store.list('sess_test')).toHaveLength(1)
    const lines = readFileSync(store.jsonlPath('sess_test'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(store.jsonlWriteFailures).toBe(0)
  })

  it('导出写失败不会让已经落库的事件变成失败', () => {
    const store = setup()
    emit(store)

    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    blockJsonlDir()

    // 关键断言：不抛异常，事件照样入库。
    expect(() => emit(store)).not.toThrow()
    expect(store.list('sess_test')).toHaveLength(2)
    expect(store.jsonlWriteFailures).toBe(1)

    // 只警告一次，不刷屏。
    emit(store)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(store.jsonlWriteFailures).toBe(2)
  })

  it('exportJsonl 能从库重建整份轨迹', () => {
    const store = setup()
    emit(store)
    emit(store)

    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    blockJsonlDir()
    emit(store) // 这条只进了库
    expect(store.jsonlWriteFailures).toBe(1)
    warn.mockRestore()

    expect(existsSync(store.jsonlPath('sess_test'))).toBe(false)

    unblockJsonlDir()
    const count = store.exportJsonl('sess_test')

    expect(count).toBe(3)
    const lines = readFileSync(store.jsonlPath('sess_test'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([1, 2, 3])
  })

  it('重建会覆盖半份文件，不会追加出重复行', () => {
    const store = setup()
    emit(store)

    // 造一份「旧导出」：内容不完整
    mkdirSync(temp.paths.events, { recursive: true })
    writeFileSync(store.jsonlPath('sess_test'), '{"stale":true}\n', 'utf8')

    emit(store)
    emit(store)
    store.exportJsonl('sess_test')

    const lines = readFileSync(store.jsonlPath('sess_test'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).not.toContain('stale')
  })
})

describe('多进程序号', () => {
  it('两个 EventStore 共享同一库时序号不重复', () => {
    temp = tempPaths('datasentry-events-')
    handle = openDatabase(temp.paths)
    const a = new EventStore(handle.db, temp.paths, undefined, handle.sqlite)
    const b = new EventStore(handle.db, temp.paths, undefined, handle.sqlite)

    const first = emit(a)
    const second = emit(b)

    expect(second.seq).toBe(first.seq + 1)
    expect(new Set([first.seq, second.seq]).size).toBe(2)
  })
})
