import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode, isDataSentryError, SessionState } from '@datasentry/core'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { seedAll } from '@datasentry/mcp-sources'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let ctx: AppContext

beforeAll(async () => {
  temp = tempPaths('datasentry-manual-review-')
  await seedAll(temp.paths)
  ctx = await createAppContext({ paths: temp.paths })
})

afterAll(async () => {
  await ctx?.close()
  temp?.cleanup()
})

function newSession() {
  return ctx.createSession({
    workspace: 'group-finance',
    request: '出 2025-09 的经营月报',
    input: { period: '2025-09' },
  })
}

/** 走到 VALIDATING → MANUAL_REVIEW，且不产出报表。 */
function manualReviewSession() {
  const session = newSession()
  ctx.sessions.transition(session.id, 0, SessionState.PLANNING)
  ctx.sessions.transition(session.id, 1, SessionState.FETCHING)
  ctx.sessions.transition(session.id, 2, SessionState.COMPUTING)
  ctx.sessions.transition(session.id, 3, SessionState.VALIDATING)
  ctx.sessions.transition(session.id, 4, SessionState.MANUAL_REVIEW)
  return ctx.sessions.require(session.id)
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (isDataSentryError(err)) return err.code
    return `UNEXPECTED: ${err instanceof Error ? err.message : String(err)}`
  }
  return 'NO_ERROR'
}

describe('MANUAL_REVIEW 人工处置', () => {
  it('retry → PAUSED，并记录人工依据', () => {
    const session = manualReviewSession()
    const updated = ctx.resolveManualReview(session.id, {
      resolution: 'retry',
      reason: '重新跑一次取数',
    })

    expect(updated.state).toBe(SessionState.PAUSED)
    expect(updated.errorMessage).toContain('重新跑一次取数')
    const event = ctx.events
      .list(session.id)
      .find((item) => item.type === 'session.state.changed')
    expect(event?.payload['reason']).toBe('manual-review:retry')
  })

  it('fail → FAILED，block → BLOCKED', () => {
    const failed = manualReviewSession()
    expect(
      ctx.resolveManualReview(failed.id, { resolution: 'fail', reason: '数据源不可用' }).state,
    ).toBe(SessionState.FAILED)

    const blocked = manualReviewSession()
    expect(
      ctx.resolveManualReview(blocked.id, { resolution: 'block', reason: '等待财务确认' }).state,
    ).toBe(SessionState.BLOCKED)
  })

  it('没有报表产物时 accept 被拒，不能把空任务结清', () => {
    const session = manualReviewSession()
    expect(
      codeOf(() =>
        ctx.resolveManualReview(session.id, { resolution: 'accept', reason: '接受' }),
      ),
    ).toBe(ErrorCode.VALIDATION_FAILED)
  })

  it('有草稿产物时 accept → DONE', async () => {
    const session = newSession()
    await ctx.runSession(session.id)
    expect(ctx.reports.bySession(session.id)).toBeDefined()
    // 正常链路走不到 MANUAL_REVIEW；直接改库模拟人工复核状态。
    ctx.database.sqlite
      .prepare('UPDATE session SET state = ? WHERE id = ?')
      .run(SessionState.MANUAL_REVIEW, session.id)

    const updated = ctx.resolveManualReview(session.id, {
      resolution: 'accept',
      reason: '人工核对通过',
    })
    expect(updated.state).toBe(SessionState.DONE)
  })

  it('非 MANUAL_REVIEW 任务不能人工处置', () => {
    const session = newSession()
    expect(
      codeOf(() =>
        ctx.resolveManualReview(session.id, { resolution: 'block', reason: 'x' }),
      ),
    ).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION)
  })
})
