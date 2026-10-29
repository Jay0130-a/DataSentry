import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import type Database from 'better-sqlite3'
import {
  parseEventJsonl,
  serializeEvent,
  newEventId,
  EventType,
  type AgentEvent,
  type DataPaths,
} from '@datasentry/core'
import { schema, type Db } from '../db/index.ts'
import type { CredentialManager } from '../credentials/manager.ts'

export interface EmitInput {
  sessionId: string
  traceId: string
  type: EventType
  payload?: Record<string, unknown>
}

/**
 * AgentEvent 事件轨迹（PRD FR-05 / §8 审计）。
 *
 * **状态库是唯一事实源，JSONL 是审计导出。**
 *
 * 顺序是「先落库、再追加文件」，而且追加失败**不会**让已经落库的操作失败：
 * 导出坏了可以重建，业务动作不能因为审计文件写不进去就变成一个假的失败。
 * 需要时用 `exportJsonl()` 从库里重建整份轨迹——它是导出，不是第二份事实。
 *
 * `seq` 在单 session 内单调递增。进程重启后从库里读当前最大值续上，
 * 保证「重启恢复」场景下轨迹仍然连续可对。
 */
export class EventStore {
  private readonly seqCache = new Map<string, number>()
  /** 预编译的原子插入语句；emit 在热路径上，不能每条事件都重新 prepare。 */
  private insertStmt: Database.Statement | null = null
  /** JSONL 追加失败的次数。非零说明审计导出落后于库，需要重建。 */
  private jsonlFailures = 0

  constructor(
    private readonly db: Db,
    private readonly paths: DataPaths,
    private readonly credentials?: CredentialManager,
    /**
     * 原始 SQLite 句柄。给了就用 `INSERT ... RETURNING seq` 原子生成序号；
     * 没有时退回进程内缓存（单进程测试场景）。
     */
    private readonly sqlite?: Database.Database,
  ) {
    mkdirSync(paths.events, { recursive: true })
  }

  get jsonlWriteFailures(): number {
    return this.jsonlFailures
  }

  jsonlPath(sessionId: string): string {
    return join(this.paths.events, `${sessionId}.jsonl`)
  }

  emit(input: EmitInput): AgentEvent {
    // 落库前统一过一遍凭据清洗：审计轨迹不能成为泄漏渠道。
    const payload = this.credentials
      ? this.credentials.scrubValue(input.payload ?? {})
      : (input.payload ?? {})
    const eventId = newEventId()
    const at = new Date().toISOString()

    let seq: number
    if (this.sqlite) {
      /*
       * 序号在**同一条 INSERT** 里由 MAX(seq)+1 生成。
       *
       * 进程内的 seqCache 在 CLI + API 同时写同一个 session 时会各算各的，
       * 产生重复序号；SQLite 的写锁保证这条语句串行执行，读到的最大值
       * 一定是上一条已提交事件。`RETURNING seq` 顺便把分配到的序号取回来。
       */
      this.insertStmt ??= this.sqlite.prepare(
        `INSERT INTO event (event_id, session_id, trace_id, seq, event_type, payload, timestamp)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM event WHERE session_id = ?), ?, ?, ?)
         RETURNING seq`,
      )
      const row = this.insertStmt.get(
          eventId,
          input.sessionId,
          input.traceId,
          input.sessionId,
          input.type,
          JSON.stringify(payload),
          at,
        ) as { seq: number }
      seq = row.seq
    } else {
      seq = this.nextSeq(input.sessionId)
      this.db
        .insert(schema.events)
        .values({
          eventId,
          sessionId: input.sessionId,
          traceId: input.traceId,
          seq,
          eventType: input.type,
          payload,
          timestamp: at,
        })
        .run()
    }

    const event: AgentEvent = {
      eventId,
      sessionId: input.sessionId,
      traceId: input.traceId,
      seq,
      type: input.type,
      at,
      payload,
    }

    this.appendJsonl(event)
    return event
  }

  /**
   * 追加到 JSONL 导出文件。
   *
   * 失败只记一次警告，不往上抛：事件已经落库，业务动作不该因为导出写不进去
   * 而对外表现为失败。需要时用 `exportJsonl` 从库里重建。
   */
  private appendJsonl(event: AgentEvent): void {
    try {
      appendFileSync(this.jsonlPath(event.sessionId), serializeEvent(event), 'utf8')
    } catch (err) {
      this.jsonlFailures += 1
      if (this.jsonlFailures === 1) {
        process.stderr.write(
          `[events] JSONL 追加失败（事件已落库，可用 \`sessions export-events\` 重建）：` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }
  }

  /**
   * 从状态库重建某个 session 的 JSONL 导出。
   *
   * 先写临时文件再 rename：中途失败不会留下半份轨迹。
   */
  exportJsonl(sessionId: string): number {
    const events = this.list(sessionId)
    mkdirSync(this.paths.events, { recursive: true })

    const target = this.jsonlPath(sessionId)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, events.map((event) => serializeEvent(event)).join(''), 'utf8')
    renameSync(tmp, target)
    return events.length
  }

  /** 批量发射，用于计算完成后一次性记录多个指标。 */
  emitMany(inputs: readonly EmitInput[]): AgentEvent[] {
    return inputs.map((input) => this.emit(input))
  }

  /** 按 seq 升序读取某个 session 的全部事件。 */
  list(sessionId: string): AgentEvent[] {
    const rows = this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.sessionId, sessionId))
      .orderBy(schema.events.seq)
      .all()

    return rows.map((row) => ({
      eventId: row.eventId,
      sessionId: row.sessionId,
      traceId: row.traceId,
      seq: row.seq,
      type: row.eventType as EventType,
      at: row.timestamp,
      payload: row.payload,
    }))
  }

  /** 直接读 JSONL 文件——回归脚本走这条路，验证的是「写出去的东西」而不是库里的副本。 */
  readJsonl(sessionId: string): AgentEvent[] {
    const file = this.jsonlPath(sessionId)
    if (!existsSync(file)) return []
    return parseEventJsonl(readFileSync(file, 'utf8'))
  }

  /**
   * 该 Session 是否读过某个 Source 的 guide。
   *
   * 从 `guide.read` 事件回查，而不是另建一张状态表——审计轨迹本来就是
   * 「这个会话做过什么」的事实来源，再存一份就会有对不上的时候。
   * 进程重启后 guide 约束依然有效，靠的就是这个回查。
   */
  hasGuideRead(sessionId: string, sourceSlug: string): boolean {
    const rows = this.db
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.sessionId, sessionId),
          eq(schema.events.eventType, EventType.GuideRead),
        ),
      )
      .all()

    return rows.some((row) => row.payload['sourceSlug'] === sourceSlug)
  }

  private nextSeq(sessionId: string): number {
    const cached = this.seqCache.get(sessionId)
    if (cached !== undefined) {
      const next = cached + 1
      this.seqCache.set(sessionId, next)
      return next
    }

    const last = this.db
      .select({ seq: schema.events.seq })
      .from(schema.events)
      .where(eq(schema.events.sessionId, sessionId))
      .orderBy(desc(schema.events.seq))
      .limit(1)
      .all()[0]

    const next = (last?.seq ?? 0) + 1
    this.seqCache.set(sessionId, next)
    return next
  }
}
