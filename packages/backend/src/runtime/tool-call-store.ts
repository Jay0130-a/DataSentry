import { asc, eq } from 'drizzle-orm'
import { newToolCallId, type ToolCall, type ToolCallStatus } from '@datasentry/core'
import { schema, type Db } from '../db/index.ts'

export interface CreateToolCallInput {
  sessionId: string
  step: number
  toolName: string
  sourceSlug: string
  paramsHash: string
  toolVersion: string
  args: Record<string, unknown>
}

function toToolCall(row: typeof schema.toolCalls.$inferSelect): ToolCall {
  return {
    id: row.id,
    sessionId: row.sessionId,
    step: row.step,
    toolName: row.toolName,
    sourceSlug: row.sourceSlug,
    paramsHash: row.paramsHash,
    toolVersion: row.toolVersion,
    status: row.status,
    args: row.args,
    resultRef: row.resultRef ?? null,
    denyCode: row.denyCode ?? null,
    denyReason: row.denyReason ?? null,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt ?? null,
  }
}

/**
 * 工具调用记录（PRD §7）。
 *
 * 被拒绝的调用**也要落库**：`status: denied` 加上 `denyCode` 是审计里最有价值的部分——
 * 「谁在什么时候试图越权取什么数据」比「谁成功取到了」更值得留痕。
 */
export class ToolCallStore {
  constructor(private readonly db: Db) {}

  create(input: CreateToolCallInput): ToolCall {
    const record: ToolCall = {
      id: newToolCallId(),
      sessionId: input.sessionId,
      step: input.step,
      toolName: input.toolName,
      sourceSlug: input.sourceSlug,
      paramsHash: input.paramsHash,
      toolVersion: input.toolVersion,
      status: 'pending',
      args: input.args,
      resultRef: null,
      denyCode: null,
      denyReason: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    }

    this.db
      .insert(schema.toolCalls)
      .values({
        id: record.id,
        sessionId: record.sessionId,
        step: record.step,
        toolName: record.toolName,
        sourceSlug: record.sourceSlug,
        paramsHash: record.paramsHash,
        toolVersion: record.toolVersion,
        status: record.status,
        args: record.args,
        resultRef: null,
        denyCode: null,
        denyReason: null,
        createdAt: record.createdAt,
        finishedAt: null,
      })
      .run()

    return record
  }

  finish(
    id: string,
    status: ToolCallStatus,
    outcome: { resultRef?: string | null; denyCode?: string | null; denyReason?: string | null } = {},
  ): ToolCall {
    this.db
      .update(schema.toolCalls)
      .set({
        status,
        resultRef: outcome.resultRef ?? null,
        denyCode: outcome.denyCode ?? null,
        denyReason: outcome.denyReason ?? null,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(schema.toolCalls.id, id))
      .run()
    return this.require(id)
  }

  get(id: string): ToolCall | undefined {
    const row = this.db.select().from(schema.toolCalls).where(eq(schema.toolCalls.id, id)).all()[0]
    return row ? toToolCall(row) : undefined
  }

  require(id: string): ToolCall {
    const call = this.get(id)
    if (!call) throw new Error(`ToolCall 不存在：${id}`)
    return call
  }

  listBySession(sessionId: string): ToolCall[] {
    return this.db
      .select()
      .from(schema.toolCalls)
      .where(eq(schema.toolCalls.sessionId, sessionId))
      .orderBy(asc(schema.toolCalls.step), asc(schema.toolCalls.createdAt))
      .all()
      .map(toToolCall)
  }

  /**
   * 悬挂中的调用——已记录但还没得出结果的那一个。
   *
   * 审批等待期间它是唯一的：一个 Session 同时只允许一个待审批调用，
   * 否则恢复时无法确定该重放哪一个。
   */
  pendingBySession(sessionId: string): ToolCall[] {
    return this.listBySession(sessionId).filter((call) => call.status === 'pending')
  }
}
