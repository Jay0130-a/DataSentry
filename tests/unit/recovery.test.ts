import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ApprovalStatus,
  ErrorCode,
  hashValue,
  SessionState,
  type Session,
} from '@datasentry/core'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { seedAll } from '@datasentry/mcp-sources'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let ctx: AppContext

beforeAll(async () => {
  temp = tempPaths('datasentry-recovery-')
  await seedAll(temp.paths)
  ctx = await createAppContext({ paths: temp.paths })
})

afterAll(async () => {
  await ctx?.close()
  temp?.cleanup()
})

function newSession(): Session {
  return ctx.createSession({
    workspace: 'group-finance',
    request: '出 2025-09 的经营月报',
    input: { period: '2025-09' },
  })
}

/** 把会话推进到 FETCHING，并留下一条悬挂的工具调用——模拟「进程在调用中途消失」。 */
function craftInterruptedSession(): { session: Session; toolCallId: string } {
  const created = newSession()
  ctx.sessions.transition(created.id, 0, SessionState.PLANNING)
  ctx.sessions.transition(created.id, 1, SessionState.FETCHING)

  const call = ctx.toolCalls.create({
    sessionId: created.id,
    step: 0,
    toolName: 'mcp__erp__fetch_revenue',
    sourceSlug: 'erp',
    paramsHash: hashValue({ period: '2025-09' }),
    toolVersion: 'v-test',
    args: { period: '2025-09' },
  })

  return { session: ctx.sessions.require(created.id), toolCallId: call.id }
}

function actionOf(sessionId: string): string {
  return ctx.recovery.scan([sessionId])[0]!.action
}

describe('恢复扫描：把残局分类清楚', () => {
  it('终态任务不动', () => {
    const created = newSession()
    ctx.sessions.transition(created.id, 0, SessionState.PLANNING)
    ctx.sessions.transition(created.id, 1, SessionState.BLOCKED)
    expect(actionOf(created.id)).toBe('skip-terminal')
  })

  it('执行到一半中断：报 mark-interrupted，并说明已完成的步数不会被重放', () => {
    const { session } = craftInterruptedSession()
    const finding = ctx.recovery.scan([session.id])[0]!

    expect(finding.action).toBe('mark-interrupted')
    expect(finding.pendingToolCall?.toolName).toBe('mcp__erp__fetch_revenue')
    expect(finding.reason).toContain('结果未知')
  })

  it('没有悬挂调用但在取数途中：报 continue-from-checkpoint', () => {
    const created = newSession()
    ctx.sessions.transition(created.id, 0, SessionState.PLANNING)
    ctx.sessions.transition(created.id, 1, SessionState.FETCHING)

    expect(actionOf(created.id)).toBe('continue-from-checkpoint')
  })

  it('WAITING_APPROVAL 却没有悬挂调用：状态自相矛盾，转人工', () => {
    const created = newSession()
    ctx.sessions.transition(created.id, 0, SessionState.PLANNING)
    ctx.sessions.transition(created.id, 1, SessionState.FETCHING)
    ctx.sessions.transition(created.id, 2, SessionState.WAITING_APPROVAL)

    expect(actionOf(created.id)).toBe('needs-manual-review')
  })

  it('审批已通过：报 resume-approved', async () => {
    const session = newSession()
    await ctx.runSession(session.id, {
      plan: {
        steps: [
          { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'finance' } },
          { id: 'e', tool: 'finance.fetch_expense_detail', args: { period: '2025-09' } },
        ],
      },
    })

    expect(actionOf(session.id)).toBe('awaiting-approval')

    const approval = ctx.approvals.latestPending(session.id)!
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务经理' })

    expect(actionOf(session.id)).toBe('resume-approved')
  })

  it('审批在停机期间过期：recover 先标记过期再报 apply-denial', async () => {
    const session = newSession()
    await ctx.runSession(session.id, {
      plan: {
        steps: [
          { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'finance' } },
          { id: 'e', tool: 'finance.fetch_expense_detail', args: { period: '2025-09' } },
        ],
      },
    })

    const approval = ctx.approvals.latestPending(session.id)!
    // 模拟「审批在进程停机期间自然过期」
    ctx.database.sqlite
      .prepare('UPDATE approval SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), approval.id)

    // scan 是只读的，不会替我们把 pending 改成 expired；recover 才会。
    const result = await ctx.runRecovery({ execute: false, sessionIds: [session.id] })
    expect(result.findings[0]?.action).toBe('apply-denial')
  })
})

describe('恢复执行：把结论落到状态上', () => {
  it('只收敛时，被中断的调用被标记、会话转 PAUSED，但**不重发**任何请求', async () => {
    const { session, toolCallId } = craftInterruptedSession()

    const result = await ctx.runRecovery({ execute: false, sessionIds: [session.id] })

    expect(result.applied).toHaveLength(1)
    expect(result.resumed).toEqual([])

    const call = ctx.toolCalls.require(toolCallId)
    expect(call.status).toBe('failed')
    expect(call.denyCode).toBe(ErrorCode.EXECUTION_INTERRUPTED)
    expect(ctx.sessions.require(session.id).state).toBe(SessionState.PAUSED)
    // 结果未知不等于有结果
    expect(call.resultRef).toBeNull()
  })

  it('状态自相矛盾的任务被转到 MANUAL_REVIEW，而不是被猜一个状态', async () => {
    const created = newSession()
    ctx.sessions.transition(created.id, 0, SessionState.PLANNING)
    ctx.sessions.transition(created.id, 1, SessionState.FETCHING)
    ctx.sessions.transition(created.id, 2, SessionState.WAITING_APPROVAL)

    const result = await ctx.runRecovery({ execute: false, sessionIds: [created.id] })

    expect(result.applied[0]?.detail).toContain('MANUAL_REVIEW')
    const session = ctx.sessions.require(created.id)
    expect(session.state).toBe(SessionState.MANUAL_REVIEW)
    expect(session.errorCode).toBe(ErrorCode.STATE_VERSION_CONFLICT)
  })

  it('过期审批被补记后果：悬挂调用被拒、会话转 BLOCKED', async () => {
    const session = newSession()
    await ctx.runSession(session.id, {
      plan: {
        steps: [
          { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'finance' } },
          { id: 'e', tool: 'finance.fetch_expense_detail', args: { period: '2025-09' } },
        ],
      },
    })

    const approval = ctx.approvals.latestPending(session.id)!
    ctx.database.sqlite
      .prepare('UPDATE approval SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), approval.id)

    const result = await ctx.runRecovery({ execute: false, sessionIds: [session.id] })

    expect(result.applied[0]?.action).toBe('apply-denial')
    const after = ctx.sessions.require(session.id)
    expect(after.state).toBe(SessionState.BLOCKED)
    expect(after.errorCode).toBe(ErrorCode.APPROVAL_EXPIRED)
    expect(ctx.toolCalls.require(approval.toolCallId).status).toBe('denied')
  })

  it('execute=true 时把已批准的任务一次跑完', async () => {
    const session = newSession()
    await ctx.runSession(session.id, {
      plan: {
        steps: [
          { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'finance' } },
          { id: 'e', tool: 'finance.fetch_expense_detail', args: { period: '2025-09' } },
        ],
      },
    })

    const approval = ctx.approvals.latestPending(session.id)!
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务经理' })

    const result = await ctx.runRecovery({ execute: true, sessionIds: [session.id] })

    expect(result.resumed).toHaveLength(1)
    expect(result.errors).toEqual([])
    // 计划里只有费用明细这一步会产出结果
    expect(result.resumed[0]?.resultCount).toBe(1)
    expect(ctx.toolCalls.require(approval.toolCallId).status).toBe('succeeded')
  })

  it('仍在等审批的任务不会被恢复动作顺手执行掉', async () => {
    const session = newSession()
    await ctx.runSession(session.id, {
      plan: {
        steps: [
          { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'finance' } },
          { id: 'e', tool: 'finance.fetch_expense_detail', args: { period: '2025-09' } },
        ],
      },
    })

    const result = await ctx.runRecovery({ execute: true, sessionIds: [session.id] })

    expect(result.resumed).toEqual([])
    expect(result.applied).toEqual([])
    expect(ctx.sessions.require(session.id).state).toBe(SessionState.WAITING_APPROVAL)
    const approval = ctx.approvals.latestPending(session.id)!
    expect(approval.status).toBe(ApprovalStatus.PENDING)
  })
})

describe('恢复死局回归', () => {
  it('新建未执行的任务报 skip-idle，不会被转成非法的 INIT → PAUSED', async () => {
    const created = newSession()

    expect(actionOf(created.id)).toBe('skip-idle')
    const result = await ctx.runRecovery({ execute: true, sessionIds: [created.id] })

    expect(result.errors).toEqual([])
    expect(ctx.sessions.require(created.id).state).toBe(SessionState.INIT)
  })

  it('scan 只读：过期审批不会被扫描顺手改掉', async () => {
    const created = newSession()
    ctx.sessions.transition(created.id, 0, SessionState.PLANNING)
    ctx.sessions.transition(created.id, 1, SessionState.FETCHING)

    const args = { period: '2025-09' }
    const call = ctx.toolCalls.create({
      sessionId: created.id,
      step: 0,
      toolName: 'mcp__erp__fetch_revenue',
      sourceSlug: 'erp',
      paramsHash: hashValue(args),
      toolVersion: 'v-test',
      args,
    })
    const approval = ctx.approvals.create({
      sessionId: created.id,
      workspaceId: 'group-finance',
      toolCallId: call.id,
      toolName: call.toolName,
      toolVersion: call.toolVersion,
      paramsHash: call.paramsHash,
      kind: 'tool-call',
    })
    ctx.database.sqlite
      .prepare('UPDATE approval SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), approval.id)

    ctx.recovery.scan([created.id])
    expect(ctx.approvals.require(approval.id).status).toBe(ApprovalStatus.PENDING)

    await ctx.runRecovery({ execute: false, sessionIds: [created.id] })
    expect(ctx.approvals.require(approval.id).status).toBe(ApprovalStatus.EXPIRED)
  })

  it('审批已拒绝且调用已结束时，恢复能按 DENIED 收敛而不是空指针', async () => {
    const created = newSession()
    ctx.sessions.transition(created.id, 0, SessionState.PLANNING)
    ctx.sessions.transition(created.id, 1, SessionState.FETCHING)

    const args = { period: '2025-09' }
    const call = ctx.toolCalls.create({
      sessionId: created.id,
      step: 0,
      toolName: 'mcp__erp__fetch_revenue',
      sourceSlug: 'erp',
      paramsHash: hashValue(args),
      toolVersion: 'v-test',
      args,
    })
    const approval = ctx.approvals.create({
      sessionId: created.id,
      workspaceId: 'group-finance',
      toolCallId: call.id,
      toolName: call.toolName,
      toolVersion: call.toolVersion,
      paramsHash: call.paramsHash,
      kind: 'tool-call',
    })
    ctx.approvals.decide(approval.id, {
      decision: 'denied',
      approver: '财务经理',
      reason: '不允许',
    })
    // 模拟「审批已落库、调用已结束，但进程在转会话状态之前挂掉」。
    ctx.toolCalls.finish(call.id, 'denied', {
      denyCode: ErrorCode.APPROVAL_DENIED,
      denyReason: '不允许',
    })
    ctx.sessions.transition(created.id, 2, SessionState.WAITING_APPROVAL)

    const result = await ctx.runRecovery({ execute: true, sessionIds: [created.id] })

    expect(result.errors).toEqual([])
    expect(ctx.sessions.require(created.id).state).toBe(SessionState.BLOCKED)
    expect(ctx.sessions.require(created.id).errorCode).toBe(ErrorCode.APPROVAL_DENIED)
  })
})
