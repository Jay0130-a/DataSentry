import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, readFileSync } from 'node:fs'
import { dataPaths } from '@datasentry/core'
import { TranscriptStore } from '@datasentry/backend/runtime/transcript-store.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths | null = null

afterEach(() => {
  temp?.cleanup()
  temp = null
})

function store(): { store: TranscriptStore; paths: ReturnType<typeof dataPaths> } {
  temp = tempPaths('datasentry-transcript-')
  const paths = dataPaths({ data: temp.paths.data })
  return { store: new TranscriptStore(paths), paths }
}

const user = { role: 'user' as const, content: '出月报', timestamp: 1 }
const assistant = {
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text: '好的' }],
  api: 'openai-completions',
  provider: 'x',
  model: 'm',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop' as const,
  timestamp: 2,
}

describe('对话记录持久化', () => {
  it('追加后能按顺序读回', () => {
    const { store: s } = store()
    s.append('sess_1', user)
    s.append('sess_1', assistant)

    const messages = s.read('sess_1')
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]!.role).toBe('assistant')
  })

  it('不同 session 互不干扰', () => {
    const { store: s } = store()
    s.append('sess_1', user)
    s.append('sess_2', assistant)
    expect(s.read('sess_1')).toHaveLength(1)
    expect(s.read('sess_2')).toHaveLength(1)
  })

  it('崩溃留下的半行被忽略，已写入的仍然可读', () => {
    // 这是 JSONL 最常见的损坏形态：最后一行写到一半就断电。
    const { store: s } = store()
    s.append('sess_1', user)
    appendFileSync(s.path('sess_1'), '{"role":"assistant","content":[{"type":"te', 'utf8')

    const messages = s.read('sess_1')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
  })

  it('write 覆盖写入，remove 清空', () => {
    const { store: s } = store()
    s.append('sess_1', user)
    s.write('sess_1', [assistant])
    expect(s.read('sess_1')).toHaveLength(1)
    expect(s.read('sess_1')[0]!.role).toBe('assistant')

    s.remove('sess_1')
    expect(s.read('sess_1')).toEqual([])
  })

  it('文件格式是一行一条 JSON', () => {
    const { store: s } = store()
    s.append('sess_1', user)
    s.append('sess_1', assistant)
    const lines = readFileSync(s.path('sess_1'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).role).toBe('user')
  })
})
