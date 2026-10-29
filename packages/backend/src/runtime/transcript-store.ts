import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import type { DataPaths } from '@datasentry/core'

/**
 * pi 对话记录的持久化（JSONL）。
 *
 * 为什么需要它：审批在 `beforeToolCall` 里挂起，进程重启后内存里的 Agent 就没了。
 * 要「从原处继续」而不是「重新规划」，就必须能把**当时的对话**原样放回去——
 * 包括模型发的 toolCall 和工具返回的 toolResult。
 *
 * 选择 JSONL 的理由和事件轨迹一致：追加写、崩溃不丢已写入的行、人工可读。
 * 一行一条 `Message`，按写入顺序即对话顺序。
 */
export class TranscriptStore {
  constructor(private readonly paths: DataPaths) {}

  path(sessionId: string): string {
    return join(this.paths.data, 'agents', `${sessionId}.jsonl`)
  }

  /** 追加若干条消息。幂等由调用方保证（每条 message_end 只追加一次）。 */
  append(sessionId: string, message: Message): void {
    const file = this.path(sessionId)
    mkdirSync(this.paths.data ? join(this.paths.data, 'agents') : '.', { recursive: true })
    appendFileSync(file, `${JSON.stringify(message)}\n`, 'utf8')
  }

  read(sessionId: string): Message[] {
    const file = this.path(sessionId)
    if (!existsSync(file)) return []

    const messages: Message[] = []
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim()
      if (!line) continue
      try {
        messages.push(JSON.parse(line) as Message)
      } catch {
        // 崩溃时可能留下半行。截断在最后一行就丢掉它，不要整份记录读不出来。
        if (i === lines.length - 1) break
        throw new Error(`对话记录 ${file} 第 ${i + 1} 行损坏`)
      }
    }
    return messages
  }

  /** 覆盖写入（用于补一条合成消息后整体重写）。 */
  write(sessionId: string, messages: readonly Message[]): void {
    const file = this.path(sessionId)
    mkdirSync(join(this.paths.data, 'agents'), { recursive: true })
    writeFileSync(file, messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''), 'utf8')
  }

  remove(sessionId: string): void {
    rmSync(this.path(sessionId), { force: true })
  }
}
