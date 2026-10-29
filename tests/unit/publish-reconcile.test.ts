import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorCode, hashValue, SessionState, type Report } from '@datasentry/core'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { seedAll } from '@datasentry/mcp-sources'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let ctx: AppContext

beforeAll(async () => {
  temp = tempPaths('datasentry-reconcile-')
  await seedAll(temp.paths)
  ctx = await createAppContext({ paths: temp.paths })
})

afterAll(async () => {
  await ctx?.close()
  temp?.cleanup()
})

async function readyReport(period = '2025-09'): Promise<Report> {
  const session = ctx.createSession({
    workspace: 'group-finance',
    request: `出 ${period} 的经营月报`,
    input: { period },
  })
  await ctx.runSession(session.id)
  const report = ctx.reports.bySession(session.id)
  if (!report) throw new Error('没有产出报表')
  return report
}

/** 走完一次完整发布：发起 → 批准 → 确认。 */
async function publish(
  report: Report,
  recipients: string[] = ['board@example.com'],
): Promise<{ receiptId: string; approvalId: string; toolCallId: string }> {
  const { approval, toolCall } = await ctx.requestPublish(report.id, {
    recipients,
    channel: 'email', format: 'xlsx',
  })
  ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务总监' })
  const result = await ctx.confirmPublish(approval.id)
  if (result.status !== 'published') throw new Error('发布没有完成')
  return { receiptId: result.receipt.receiptId, approvalId: approval.id, toolCallId: toolCall.id }
}

/**
 * 把本地记账回退到「投递之前」，但保留网关侧的回执。
 *
 * 这就是那个崩溃窗口：网关已经投递，进程在 `reports.patch` 之前挂掉。
 * 正常代码路径走不到这里（DONE 不允许回到 WAITING_APPROVAL），
 * 所以只能直接改库——这也正是「进程崩溃」的语义。
 */
function simulateInterruptedBookkeeping(sessionId: string, reportId: string): void {
  ctx.reports.patch(reportId, { status: 'draft', receiptId: null })
  ctx.database.sqlite
    .prepare('UPDATE session SET state = ? WHERE id = ?')
    .run(SessionState.WAITING_APPROVAL, sessionId)
}

describe('发布结果未知时查回执', () => {
  it('本地没记账但网关有回执 → 补齐记账，不重发', async () => {
    const report = await readyReport('2025-08')
    const { receiptId } = await publish(report)

    simulateInterruptedBookkeeping(report.sessionId, report.id)
    expect(ctx.reports.require(report.id).status).toBe('draft')

    const result = await ctx.reconcilePublish(report.sessionId)

    expect(result.status).toBe('reconciled')
    const patched = ctx.reports.require(report.id)
    expect(patched.status).toBe('published')
    expect(patched.receiptId).toBe(receiptId)
    // 关键：只有一条回执，说明**没有重发**
    expect(ctx.publishReceipts(report.id)).toHaveLength(1)
    // 补记之后任务结清
    expect(ctx.sessions.require(report.sessionId).state).toBe(SessionState.DONE)
  })

  it('补记会留下 publish.reconciled 事件，说明「未重发」', async () => {
    const report = await readyReport('2025-07')
    await publish(report)
    simulateInterruptedBookkeeping(report.sessionId, report.id)

    await ctx.reconcilePublish(report.sessionId)

    const events = ctx.events.readJsonl(report.sessionId)
    const reconciled = events.find((event) => event.type === 'publish.reconciled')
    expect(reconciled).toBeDefined()
    expect(reconciled?.payload['reason']).toContain('未重发')
  })

  it('记账已完成时是幂等的，不会重复补记', async () => {
    const report = await readyReport('2025-06')
    const { receiptId } = await publish(report)

    const result = await ctx.reconcilePublish(report.sessionId)
    expect(result).toEqual({ status: 'already-published', receiptId })
  })

  it('网关没有回执且调用未完成 → 判定未投递，可以安全重试', async () => {
    const report = await readyReport('2025-05')
    const { approval, toolCall } = await ctx.requestPublish(report.id, {
      recipients: ['audit@example.com'],
      channel: 'email', format: 'xlsx',
    })
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务总监' })
    // 只发起不确认：调用停在 pending，网关侧什么都没有

    const result = await ctx.reconcilePublish(report.sessionId)

    expect(result.status).toBe('not-delivered')
    if (result.status === 'not-delivered') expect(result.toolCallId).toBe(toolCall.id)
    expect(ctx.reports.require(report.id).status).toBe('draft')
    expect(ctx.publishReceipts(report.id)).toHaveLength(0)
  })

  it('从未发起过发布 → 无法判定，如实说明', async () => {
    const report = await readyReport('2025-04')
    const result = await ctx.reconcilePublish(report.sessionId)
    expect(result).toEqual({ status: 'unknown', reason: '该任务从未发起过发布确认' })
  })
})

describe('恢复扫描识别发布残局', () => {
  it('结算未完成的发布被扫成 resolve-publish', async () => {
    const report = await readyReport('2025-02')
    await publish(report)
    simulateInterruptedBookkeeping(report.sessionId, report.id)

    const finding = ctx.recovery.scan([report.sessionId])[0]!
    expect(finding.action).toBe('resolve-publish')
    expect(finding.reason).toContain('先查回执，不重发')
  })

  it('一条 recover 就能把发布补齐，且仍然只有一条回执', async () => {
    const report = await readyReport('2025-01')
    await publish(report, ['board@example.com', 'audit@example.com'])
    simulateInterruptedBookkeeping(report.sessionId, report.id)

    const result = await ctx.runRecovery({ execute: false, sessionIds: [report.sessionId] })

    expect(result.applied[0]?.action).toBe('resolve-publish')
    expect(ctx.reports.require(report.id).status).toBe('published')
    expect(ctx.publishReceipts(report.id)).toHaveLength(1)
    expect(ctx.sessions.require(report.sessionId).state).toBe(SessionState.DONE)
  })
})

describe('参数与摘要必须自洽', () => {
  /**
   * 内联计划：读一次 guide，然后调用机密工具。
   * 恢复时必须把**同一份**计划再传一次——恢复只重放被批准的那一步，
   * 之后还要靠规划器决定下一步往哪走。生产环境只有一份计划，调用方覆盖过就得一路覆盖。
   */
  const sensitivePlan = (period: string) => ({
    steps: [
      { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'finance' } },
      { id: 'e', tool: 'finance.fetch_expense_detail', args: { period } },
    ],
  })

  it('只改参数不改摘要，会被拦下——绑定不能绕过', async () => {
    const period = '2024-12'
    const session = ctx.createSession({
      workspace: 'group-finance',
      request: `出 ${period} 的费用明细`,
      input: { period },
    })
    await ctx.runSession(session.id, { plan: sensitivePlan(period) })

    const pending = ctx.toolCalls.pendingBySession(session.id)
    expect(pending).toHaveLength(1)
    const call = pending[0]!

    // 攻击：把参数换成另一个**同样合法**的期间，但不动 params_hash。
    // 绑定比对的是摘要字段，执行用的是参数——只改后者，绑定看上去仍然匹配。
    ctx.database.sqlite
      .prepare('UPDATE tool_call SET args = ? WHERE id = ?')
      .run(JSON.stringify({ period: '2024-11' }), call.id)

    const approval = ctx.approvals.latestPending(session.id)!
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务经理' })

    const outcome = await ctx.resumeSession(session.id, { plan: sensitivePlan(period) })

    expect(outcome.state).toBe(SessionState.BLOCKED)
    expect(outcome.errorCode).toBe(ErrorCode.APPROVAL_PARAMS_DRIFT)
    // 原始调用没有被执行
    expect(outcome.results).toHaveLength(0)
    expect(ctx.toolCalls.require(call.id).status).toBe('denied')
  })

  it('参数没被改动时照常放行——这条检查不会误伤正常路径', async () => {
    const period = '2024-10'
    const session = ctx.createSession({
      workspace: 'group-finance',
      request: `出 ${period} 的费用明细`,
      input: { period },
    })
    await ctx.runSession(session.id, { plan: sensitivePlan(period) })

    const call = ctx.toolCalls.pendingBySession(session.id)[0]!
    // 摘要确实等于参数摘要（说明记录是自洽的）
    expect(call.paramsHash).toBe(hashValue(call.args))

    const approval = ctx.approvals.latestPending(session.id)!
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务经理' })
    const outcome = await ctx.resumeSession(session.id, { plan: sensitivePlan(period) })

    // 这一条验的是「自洽的记录不被误伤」，不是整条链路能跑完：
    // 两步骤的计划只产出费用明细，缺少必需指标，最终会因校验失败而结束（这是对的）。
    // 要断言的是调用本身跑通了、并且没有撞上漂移检查。
    expect(ctx.toolCalls.require(call.id).status).toBe('succeeded')
    expect(outcome.errorCode).not.toBe(ErrorCode.APPROVAL_PARAMS_DRIFT)
  })
})

describe('already-published 的恢复收敛', () => {
  it('report 已发布但会话仍 WAITING_APPROVAL：恢复补到 DONE，不重发', async () => {
    const report = await readyReport('2025-07')
    const { receiptId } = await publish(report)

    // 模拟 finalizePublish 写完 report、还没来得及转 session 就崩溃。
    ctx.database.sqlite
      .prepare('UPDATE session SET state = ? WHERE id = ?')
      .run(SessionState.WAITING_APPROVAL, report.sessionId)

    const result = await ctx.runRecovery({
      execute: true,
      sessionIds: [report.sessionId],
    })

    expect(result.errors).toEqual([])
    expect(result.findings[0]?.action).toBe('resolve-publish')
    expect(ctx.sessions.require(report.sessionId).state).toBe(SessionState.DONE)
    expect(ctx.reports.require(report.id).receiptId).toBe(receiptId)
    // 关键：没有第二条回执
    expect(ctx.publishReceipts(report.id)).toHaveLength(1)
  })

  it('report 已发布但会话是 READY：恢复同样补到 DONE', async () => {
    const report = await readyReport('2025-06')
    await publish(report)

    ctx.database.sqlite
      .prepare('UPDATE session SET state = ? WHERE id = ?')
      .run(SessionState.READY, report.sessionId)

    const result = await ctx.runRecovery({
      execute: true,
      sessionIds: [report.sessionId],
    })

    expect(result.errors).toEqual([])
    expect(result.findings[0]?.action).toBe('resolve-publish')
    expect(ctx.sessions.require(report.sessionId).state).toBe(SessionState.DONE)
  })
})
