import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode, isDataSentryError, SessionState } from '@datasentry/core'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { seedAll } from '@datasentry/mcp-sources'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let ctx: AppContext

beforeAll(async () => {
  temp = tempPaths('datasentry-pi-loop-')
  await seedAll(temp.paths)
  ctx = await createAppContext({
    paths: temp.paths,
    modelProvider: 'mock',
    agentLoop: 'pi',
    maxSteps: 1,
  })
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

describe('pi 循环的边界', () => {
  it('maxSteps 在执行前生效，不会让模型无限调工具', async () => {
    const session = newSession()
    const outcome = await ctx.runSession(session.id, {
      plan: {
        steps: [
          { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'erp' } },
          { id: 'r', tool: 'erp.fetch_revenue', args: { period: '2025-09' } },
        ],
      },
    })

    expect(outcome.state).toBe(SessionState.FAILED)
    expect(outcome.errorCode).toBe(ErrorCode.TOOL_EXECUTION_FAILED)
    // 第 2 次调用在执行前被拦下，只有第 1 步真正跑过
    expect(outcome.steps).toBeLessThanOrEqual(1)
  })

  it('PAUSED 不会被当作全新任务重跑，也不会删掉对话记录', async () => {
    const session = newSession()
    ctx.sessions.transition(session.id, 0, SessionState.PLANNING)
    ctx.sessions.transition(session.id, 1, SessionState.PAUSED)

    try {
      await ctx.runSession(session.id)
      throw new Error('本应拒绝 PAUSED 的就地执行')
    } catch (err) {
      expect(isDataSentryError(err)).toBe(true)
      expect((err as { code: ErrorCode }).code).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION)
    }

    expect(ctx.sessions.require(session.id).state).toBe(SessionState.PAUSED)
  })
})
