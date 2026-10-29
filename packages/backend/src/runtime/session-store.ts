import { and, eq, inArray } from 'drizzle-orm'
import {
  DEFAULT_SESSION_STATE,
  ErrorCode,
  fail,
  hashValue,
  assertTransition,
  newSessionId,
  newTraceId,
  type Session,
  type SessionState,
} from '@datasentry/core'
import { schema, type Db } from '../db/index.ts'

export interface CreateSessionRecord {
  workspaceId: string
  skillName: string
  skillVersion: string
  request: string
  input: Record<string, unknown>
  /** 发起人账号；CLI 与回归直接调用时没有。 */
  createdBy?: string | null
}

function toSession(row: typeof schema.sessions.$inferSelect): Session {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    createdBy: row.createdBy ?? null,
    state: row.state,
    step: row.step,
    stateVersion: row.stateVersion,
    skillVersion: row.skillVersion,
    inputVersion: row.inputVersion,
    traceId: row.traceId,
    skillName: row.skillName,
    request: row.request,
    input: row.input,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** 输入版本：请求 + 结构化输入 + Skill 版本的摘要。检查点据此判断是否还对得上当前输入。 */
export function computeInputVersion(input: {
  request: string
  data: Record<string, unknown>
  skillVersion: string
}): string {
  return hashValue(input).slice(0, 16)
}

/**
 * Session 状态库（PRD FR-04）。
 *
 * 所有状态写入都走 `updateState`，而它强制要求传入期望的 `stateVersion`：
 * 版本对不上就抛 `STATE_VERSION_CONFLICT`，不覆盖。
 *
 * 这一条是「重启后旧执行器不会写坏新状态」的全部保障——没有它，
 * 恢复逻辑再完善也只是在和一个并发写竞争。
 */
export class SessionStore {
  constructor(private readonly db: Db) {}

  create(record: CreateSessionRecord): Session {
    const now = new Date().toISOString()
    const session: Session = {
      id: newSessionId(),
      workspaceId: record.workspaceId,
      createdBy: record.createdBy ?? null,
      state: DEFAULT_SESSION_STATE,
      step: 0,
      stateVersion: 0,
      skillVersion: record.skillVersion,
      inputVersion: computeInputVersion({
        request: record.request,
        data: record.input,
        skillVersion: record.skillVersion,
      }),
      traceId: newTraceId(),
      skillName: record.skillName,
      request: record.request,
      input: record.input,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    }

    this.db
      .insert(schema.sessions)
      .values({
        id: session.id,
        workspaceId: session.workspaceId,
        createdBy: session.createdBy,
        state: session.state,
        step: session.step,
        stateVersion: session.stateVersion,
        skillVersion: session.skillVersion,
        inputVersion: session.inputVersion,
        traceId: session.traceId,
        skillName: session.skillName,
        request: session.request,
        input: session.input,
        errorCode: null,
        errorMessage: null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      })
      .run()

    return session
  }

  get(id: string): Session | undefined {
    const row = this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).all()[0]
    return row ? toSession(row) : undefined
  }

  require(id: string): Session {
    const session = this.get(id)
    if (!session) fail(ErrorCode.SESSION_NOT_FOUND, `Session 不存在：${id}`, { sessionId: id })
    return session
  }

  list(workspaceId?: string): Session[] {
    const rows = workspaceId
      ? this.db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.workspaceId, workspaceId))
          .all()
      : this.db.select().from(schema.sessions).all()
    return rows.map(toSession).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * 按可见 Workspace 取任务。
   *
   * `workspaceIds === null` 表示不过滤（管理员）；空数组表示**一个都看不到**。
   * 这两种情况必须分开——把空数组当成「不过滤」，新账号就会看到全部任务。
   */
  listScoped(workspaceIds: readonly string[] | null, workspaceId?: string): Session[] {
    if (workspaceIds !== null && workspaceIds.length === 0) return []

    const conditions = []
    if (workspaceIds !== null) {
      conditions.push(inArray(schema.sessions.workspaceId, [...workspaceIds]))
    }
    if (workspaceId !== undefined) {
      conditions.push(eq(schema.sessions.workspaceId, workspaceId))
    }

    const rows =
      conditions.length > 0
        ? this.db
            .select()
            .from(schema.sessions)
            .where(and(...conditions))
            .all()
        : this.db.select().from(schema.sessions).all()

    return rows.map(toSession).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * 状态转移 + 乐观锁更新。
   *
   * 先做状态机合法性校验（非法转移直接拒绝），再做版本比对（并发写直接拒绝）。
   * 两个检查顺序不能反：合法性是「这个动作对不对」，版本是「这次写入还赶不赶得上」。
   */
  transition(
    id: string,
    expectedVersion: number,
    to: SessionState,
    patch: { step?: number; errorCode?: string | null; errorMessage?: string | null } = {},
  ): Session {
    const current = this.require(id)
    assertTransition(current.state, to)

    const updated = this.db
      .update(schema.sessions)
      .set({
        state: to,
        stateVersion: current.stateVersion + 1,
        step: patch.step ?? current.step,
        errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
        errorMessage: patch.errorMessage === undefined ? current.errorMessage : patch.errorMessage,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(schema.sessions.id, id), eq(schema.sessions.stateVersion, expectedVersion)),
      )
      .run()

    if (updated.changes === 0) {
      fail(
        ErrorCode.STATE_VERSION_CONFLICT,
        `Session ${id} 的状态版本已变化（期望 ${expectedVersion}，实际 ${this.require(id).stateVersion}）`,
        { sessionId: id, expectedVersion },
      )
    }

    return this.require(id)
  }

  /** 只推进 step，不改状态。用于一次 FETCHING 内的多次工具调用。 */
  bumpStep(id: string, expectedVersion: number): Session {
    const current = this.require(id)
    const updated = this.db
      .update(schema.sessions)
      .set({
        step: current.step + 1,
        stateVersion: current.stateVersion + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.sessions.id, id), eq(schema.sessions.stateVersion, expectedVersion)))
      .run()

    if (updated.changes === 0) {
      fail(ErrorCode.STATE_VERSION_CONFLICT, `Session ${id} 的状态版本已变化`, {
        sessionId: id,
        expectedVersion,
      })
    }
    return this.require(id)
  }

  setError(id: string, code: string | null, message: string | null): void {
    this.db
      .update(schema.sessions)
      .set({
        errorCode: code,
        errorMessage: message,
        stateVersion: this.require(id).stateVersion + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.sessions.id, id))
      .run()
  }
}
