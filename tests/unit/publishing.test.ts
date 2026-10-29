import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode, isDataSentryError, type Report } from '@datasentry/core'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { computeRecipientsHash, precheckPublish } from '@datasentry/backend/reports/publishing.ts'
import { seedAll } from '@datasentry/mcp-sources'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let ctx: AppContext

/** 跑一个完整会话直到 READY，产出一份可发布的草稿。 */
async function readyReport(period = '2025-09'): Promise<Report> {
  const session = ctx.createSession({
    workspace: 'group-finance',
    request: `出 ${period} 的经营月报`,
    input: { period },
  })
  await ctx.runSession(session.id)
  const report = ctx.reports.bySession(session.id)
  if (!report) throw new Error(`会话 ${session.id} 没有产出报表`)
  return report
}

function expectCode(fn: () => unknown, code: ErrorCode): void {
  try {
    fn()
    throw new Error(`本应抛出 ${code}`)
  } catch (err) {
    if (!isDataSentryError(err)) throw err
    expect(err.code).toBe(code)
  }
}

async function expectCodeAsync(fn: () => Promise<unknown>, code: ErrorCode): Promise<void> {
  try {
    await fn()
    throw new Error(`本应抛出 ${code}`)
  } catch (err) {
    if (!isDataSentryError(err)) throw err
    expect(err.code).toBe(code)
  }
}

beforeAll(async () => {
  temp = tempPaths('datasentry-publish-')
  await seedAll(temp.paths)
  ctx = await createAppContext({ paths: temp.paths })
})

afterAll(async () => {
  await ctx?.close()
  temp?.cleanup()
})

describe('发布前置校验', () => {
  it('接收人不在 Workspace 名单内直接拒绝', async () => {
    const report = await readyReport()
    const precheck = precheckPublish({
      report,
      allowedRecipients: ['board@example.com'],
      request: { recipients: ['board@example.com', 'outsider@evil.example'], channel: 'email', format: 'xlsx' },
    })

    expect(precheck.ok).toBe(false)
    expect(precheck.failures.join()).toContain('outsider@evil.example')
  })

  it('存在口径冲突的报表不能发布', async () => {
    const report = await readyReport('2025-08')
    const conflicted: Report = {
      ...report,
      conflicts: [
        {
          metricKey: 'revenue',
          description: '数仓与 ERP 差异超阈值',
          candidates: [{ sourceSlug: 'erp', resultId: 'res_x', value: 1 }],
        },
      ],
    }

    const precheck = precheckPublish({
      report: conflicted,
      allowedRecipients: ['board@example.com'],
      request: { recipients: ['board@example.com'], channel: 'email', format: 'xlsx' },
    })
    expect(precheck.ok).toBe(false)
    expect(precheck.failures.join()).toContain('口径冲突')
  })

  it('接收人规范化：去重、去空白、大写转小写', () => {
    expect(
      computeRecipientsHash({ recipients: [' A@X.com ', 'a@x.com', 'B@X.com'], channel: 'email', format: 'xlsx' }),
    ).toBe(computeRecipientsHash({ recipients: ['b@x.com', 'a@x.com'], channel: 'email', format: 'xlsx' }))
  })

  it('接收人相同但渠道不同，绑定摘要不同', () => {
    const base = ['board@example.com']
    expect(computeRecipientsHash({ recipients: base, channel: 'email', format: 'xlsx' })).not.toBe(
      computeRecipientsHash({ recipients: base, channel: 'portal', format: 'xlsx' }),
    )
  })
})

describe('发布二次确认', () => {
  it('发起发布后任务进入 WAITING_APPROVAL，且确认绑定草稿版本与接收人', async () => {
    const report = await readyReport('2025-07')
    const session = ctx.sessions.require(report.sessionId)

    const result = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email', format: 'xlsx',
    })

    expect(result.approval.kind).toBe('publish')
    // 绑定三件套：草稿版本、接收人摘要、工具版本
    expect(result.approval.draftVersion).toBe(report.draftVersion)
    expect(result.approval.recipientsHash).toBe(
      computeRecipientsHash({ recipients: ['board@example.com'], channel: 'email', format: 'xlsx' }),
    )
    expect(result.approval.toolVersion).not.toBe('unknown')

    expect(ctx.sessions.require(session.id).state).toBe('WAITING_APPROVAL')
    expect(ctx.reports.require(report.id).recipientsHash).toBe(result.approval.recipientsHash)
  })

  it('尚未批准时确认只返回 pending，不投递', async () => {
    const report = await readyReport('2025-06')
    const { approval } = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email', format: 'xlsx',
    })

    const result = await ctx.confirmPublish(approval.id)
    expect(result.status).toBe('pending')
    expect(ctx.reports.require(report.id).status).toBe('draft')
  })

  it('批准后确认才真正投递，并落到 DONE 与回执', async () => {
    const report = await readyReport('2025-05')
    const sessionId = report.sessionId
    const { approval } = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com', 'audit@example.com'],
      channel: 'email', format: 'xlsx',
    })

    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务总监' })
    const result = await ctx.confirmPublish(approval.id)

    expect(result.status).toBe('published')
    if (result.status !== 'published') throw new Error('unreachable')
    expect(result.receipt.deduplicated).toBe(false)
    expect(result.receipt.recipients).toEqual(['audit@example.com', 'board@example.com'])

    const published = ctx.reports.require(report.id)
    expect(published.status).toBe('published')
    expect(published.receiptId).toBe(result.receipt.receiptId)
    expect(ctx.sessions.require(sessionId).state).toBe('DONE')
  })

  it('接收人被改动后，已批准的确认失效', async () => {
    const report = await readyReport('2025-04')
    const { approval } = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email', format: 'xlsx',
    })
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务总监' })

    // 模拟确认与执行之间接收人被改掉
    ctx.reports.patch(report.id, { recipientsHash: 'tampered-hash' })

    await expect(ctx.confirmPublish(approval.id)).rejects.toMatchObject({
      code: ErrorCode.APPROVAL_PARAMS_DRIFT,
    })
    expect(ctx.reports.require(report.id).status).toBe('draft')
  })

  it('草稿被重算后，已批准的确认失效', async () => {
    const report = await readyReport('2025-03')
    const { approval } = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email', format: 'xlsx',
    })
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务总监' })

    ctx.reports.patch(report.id, { draftVersion: 'v1-something-else' })

    await expect(ctx.confirmPublish(approval.id)).rejects.toMatchObject({
      code: ErrorCode.APPROVAL_PARAMS_DRIFT,
    })
  })

  it('新的发布请求取代旧确认后，旧确认不可再用', async () => {
    const report = await readyReport('2025-02')
    const first = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email', format: 'xlsx',
    })
    ctx.decideApproval(first.approval.id, { decision: 'granted', approver: '财务总监' })

    const second = await ctx.requestPublish(report.id, {
      recipients: ['bu-managers@example.com'],
      channel: 'email', format: 'xlsx',
    })

    expect(ctx.approvals.require(first.approval.id).status).toBe('revoked')
    await expect(ctx.confirmPublish(first.approval.id)).rejects.toMatchObject({
      code: ErrorCode.APPROVAL_INVALID,
    })
    expect(second.approval.recipientsHash).not.toBe(first.approval.recipientsHash)
  })

  it('发布确认被拒时回到 READY，可以改名单重来', async () => {
    const report = await readyReport('2025-01')
    const { approval } = await ctx.requestPublish(report.id, {
      recipients: ['audit@example.com'],
      channel: 'email', format: 'xlsx',
    })

    ctx.decideApproval(approval.id, {
      decision: 'denied',
      approver: '财务总监',
      reason: '名单需要再确认',
    })

    expect(ctx.sessions.require(report.sessionId).state).toBe('READY')
    expect(ctx.reports.require(report.id).status).toBe('draft')
  })
})

describe('发布网关幂等', () => {
  /**
   * 网关现在要求带上「投递的是哪一份文件」：文件名、路径、摘要、大小。
   * 这正是发布语义的核心——不是一个 reportId，而是几个具体的字节。
   */
  function fileBinding(name: string): {
    artifactPath: string
    fileName: string
    sha256: string
    sizeBytes: number
    mimeType: string
  } {
    const artifactPath = join(temp.paths.data, `${name}.xlsx`)
    writeFileSync(artifactPath, `fake-xlsx-${name}`, 'utf8')
    const bytes = readFileSync(artifactPath)
    return {
      artifactPath,
      fileName: `${name}.xlsx`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }
  }

  it('同一草稿版本发给同一批接收人只会投递一次', async () => {
    const built = await ctx.ensureSources()
    const gateway = built.transports.get('publish')!

    const args = {
      reportId: 'rpt_dedupe',
      draftVersion: 'v1-abcdef',
      recipients: ['board@example.com', 'audit@example.com'],
      channel: 'email',
      format: 'xlsx',
      ...fileBinding('dedupe'),
    }

    const first = await gateway.call('publish_report', args)
    const second = await gateway.call('publish_report', args)

    const firstData = first.data as { receiptId: string; deduplicated: boolean }
    const secondData = second.data as { receiptId: string; deduplicated: boolean }

    expect(firstData.deduplicated).toBe(false)
    expect(secondData.deduplicated).toBe(true)
    // 去重命中返回的是**原回执**，不是一张新回执
    expect(secondData.receiptId).toBe(firstData.receiptId)
  })

  it('接收人变了就是一次新的投递', async () => {
    const built = await ctx.ensureSources()
    const gateway = built.transports.get('publish')!

    const base = {
      reportId: 'rpt_dedupe2',
      draftVersion: 'v1-abcdef',
      channel: 'email',
      format: 'xlsx',
      ...fileBinding('dedupe2'),
    }
    const a = await gateway.call('publish_report', { ...base, recipients: ['board@example.com'] })
    const b = await gateway.call('publish_report', {
      ...base,
      recipients: ['board@example.com', 'audit@example.com'],
    })

    expect((a.data as { deduplicated: boolean }).deduplicated).toBe(false)
    expect((b.data as { deduplicated: boolean }).deduplicated).toBe(false)
    expect((b.data as { receiptId: string }).receiptId).not.toBe(
      (a.data as { receiptId: string }).receiptId,
    )
  })

  it('格式变了也是新的投递（同一内容发 Excel 与发 PDF 是两件事）', async () => {
    const built = await ctx.ensureSources()
    const gateway = built.transports.get('publish')!

    const base = {
      reportId: 'rpt_dedupe3',
      draftVersion: 'v1-abcdef',
      recipients: ['board@example.com'],
      channel: 'email',
    }
    const xlsx = await gateway.call('publish_report', {
      ...base,
      format: 'xlsx',
      ...fileBinding('fmt-xlsx'),
    })
    const pdf = await gateway.call('publish_report', {
      ...base,
      format: 'pdf',
      ...fileBinding('fmt-pdf'),
    })

    expect((xlsx.data as { deduplicated: boolean }).deduplicated).toBe(false)
    expect((pdf.data as { deduplicated: boolean }).deduplicated).toBe(false)
    expect((pdf.data as { receiptId: string }).receiptId).not.toBe(
      (xlsx.data as { receiptId: string }).receiptId,
    )
  })

  it('已发布的报表不能再发起发布', async () => {
    const report = await readyReport('2024-11')
    const { approval } = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email', format: 'xlsx',
    })
    ctx.decideApproval(approval.id, { decision: 'granted', approver: '财务总监' })
    const published = await ctx.confirmPublish(approval.id)
    expect(published.status).toBe('published')

    // 会话已到 DONE、报表已是 published，两道闸都会拦下重发
    await expectCodeAsync(
      () => ctx.requestPublish(report.id, { recipients: ['board@example.com'], channel: 'email', format: 'xlsx' }),
      ErrorCode.ILLEGAL_STATE_TRANSITION,
    )
  })
})

describe('审批有效期', () => {
  it('超过有效期后即使已批准也不能执行', async () => {
    const report = await readyReport('2024-10')

    const session = ctx.createSession({
      workspace: 'group-finance',
      request: '出 2025-09 的费用明细',
      input: { period: '2025-09' },
    })
    const outcome = await ctx.runSession(session.id, {
      plan: {
        steps: [
          { id: 'g', tool: 'datasentry__read_source_guide', args: { sourceSlug: 'finance' } },
          { id: 'e', tool: 'finance.fetch_expense_detail', args: { period: '2025-09' } },
        ],
      },
    })
    expect(outcome.state).toBe('WAITING_APPROVAL')

    const approval = ctx.approvals.latestPending(session.id)
    expect(approval).toBeDefined()
    ctx.decideApproval(approval!.id, { decision: 'granted', approver: '财务经理' })

    // 把有效期拨到过去，确定性地构造「批准了但已过期」
    ctx.database.sqlite
      .prepare('UPDATE approval SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), approval!.id)

    const resumed = await ctx.resumeSession(session.id)

    expect(resumed.state).toBe('BLOCKED')
    expect(resumed.errorCode).toBe(ErrorCode.APPROVAL_EXPIRED)
    // 原 ToolCall 没有被执行
    expect(resumed.results).toHaveLength(0)
    void report
  })
})
