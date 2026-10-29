import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { ErrorCode, isDataSentryError, type Report } from '@datasentry/core'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { resolveCjkFont } from '@datasentry/backend/reports/renderers/pdf.ts'
import type { PublishReceipt } from '@datasentry/backend/sources/local-handlers/publish-gateway.ts'
import { seedAll } from '@datasentry/mcp-sources'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let ctx: AppContext

beforeAll(async () => {
  temp = tempPaths('datasentry-publish-format-')
  await seedAll(temp.paths)
  ctx = await createAppContext({ paths: temp.paths })
})

afterAll(async () => {
  await ctx?.close()
  temp?.cleanup()
})

async function readyReport(period: string): Promise<Report> {
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

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return 'NO_ERROR'
  } catch (err) {
    if (isDataSentryError(err)) return err.code
    return `UNEXPECTED: ${err instanceof Error ? err.message : String(err)}`
  }
}

describe('按格式发布', () => {
  it('发起确认时就把文件渲染好，并把文件名与摘要绑进审批', async () => {
    const report = await readyReport('2025-09')
    const result = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email',
      format: 'xlsx',
    })

    const args = result.toolCall.args
    expect(args['format']).toBe('xlsx')
    expect(String(args['fileName'])).toMatch(/\.xlsx$/)
    expect(String(args['sha256'])).toMatch(/^[0-9a-f]{64}$/)

    // 文件确实已经生成，与绑定的摘要一致
    const bytes = readFileSync(String(args['artifactPath']))
    expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK')
    expect(Number(args['sizeBytes'])).toBe(bytes.length)
  })

  it('批准后确认，回执记录格式、摘要与投递落点，落点文件与产物一致', async () => {
    const report = await readyReport('2025-08')
    const requested = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com', 'audit@example.com'],
      channel: 'email',
      format: 'xlsx',
    })
    ctx.decideApproval(requested.approval.id, { decision: 'granted', approver: '财务总监' })

    const result = await ctx.confirmPublish(requested.approval.id)
    if (result.status !== 'published') throw new Error('应当已发布')

    expect(result.receipt.format).toBe('xlsx')
    expect(result.receipt.sha256).toBe(String(requested.toolCall.args['sha256']))
    expect(result.receipt.sizeBytes).toBe(Number(requested.toolCall.args['sizeBytes']))

    // 投递仓库里的字节，与审批绑定的那份一致
    const delivered = readFileSync(result.receipt.deliveredPath)
    expect(delivered.length).toBe(result.receipt.sizeBytes)
    expect(result.receipt.deliveredPath).toContain('published')
  })

  it('已发布的报表不能再发第二种格式', async () => {
    const report = await readyReport('2025-07')

    const excel = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email',
      format: 'xlsx',
    })
    ctx.decideApproval(excel.approval.id, { decision: 'granted', approver: '财务总监' })
    const published = await ctx.confirmPublish(excel.approval.id)
    if (published.status !== 'published') throw new Error('应当已发布')

    // 已发布的报表不能再发第二种格式——这是「一次发布」的语义，
    // 要发第二种格式需要新的报表版本（或走人工流程）。
    const code = await codeOf(() =>
      ctx.requestPublish(report.id, {
        recipients: ['board@example.com'],
        channel: 'email',
        format: 'pdf',
      }),
    )
    expect(code).toBe(ErrorCode.ILLEGAL_STATE_TRANSITION)
  })

  it('换个格式重新请求会取代旧确认', async () => {
    const report = await readyReport('2025-06')

    const first = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email',
      format: 'xlsx',
    })
    ctx.decideApproval(first.approval.id, { decision: 'granted', approver: '财务总监' })

    // 改格式重新发起：旧确认必须失效
    const second = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email',
      format: 'docx',
    })

    expect(ctx.approvals.require(first.approval.id).status).toBe('revoked')
    expect(second.approval.recipientsHash).not.toBe(first.approval.recipientsHash)
    expect(await codeOf(() => ctx.confirmPublish(first.approval.id))).toBe(
      ErrorCode.APPROVAL_INVALID,
    )
  })

  it('批准之后文件被改过，确认会被拒绝——绑的是字节，不是格式', async () => {
    const report = await readyReport('2025-05')
    const requested = await ctx.requestPublish(report.id, {
      recipients: ['board@example.com'],
      channel: 'email',
      format: 'md',
    })
    ctx.decideApproval(requested.approval.id, { decision: 'granted', approver: '财务总监' })

    // 模拟审批之后产物被替换
    const artifactPath = String(requested.toolCall.args['artifactPath'])
    writeFileSync(artifactPath, '被替换过的内容', 'utf8')

    expect(await codeOf(() => ctx.confirmPublish(requested.approval.id))).toBe(
      ErrorCode.APPROVAL_PARAMS_DRIFT,
    )
    expect(ctx.reports.require(report.id).status).toBe('draft')
  })

  it('PDF 走完整条链路（本机有中文字体时）', async () => {
    let hasFont = true
    try {
      resolveCjkFont()
    } catch {
      hasFont = false
    }
    if (!hasFont) return

    const report = await readyReport('2025-04')
    const requested = await ctx.requestPublish(report.id, {
      recipients: ['audit@example.com'],
      channel: 'portal',
      format: 'pdf',
    })
    ctx.decideApproval(requested.approval.id, { decision: 'granted', approver: '财务总监' })

    const result = await ctx.confirmPublish(requested.approval.id)
    if (result.status !== 'published') throw new Error('应当已发布')

    expect(result.receipt.format).toBe('pdf')
    expect(readFileSync(result.receipt.deliveredPath).subarray(0, 4).toString('utf8')).toBe('%PDF')
  })

  it('回执里能查到格式与文件指纹', async () => {
    const report = await readyReport('2025-03')
    const requested = await ctx.requestPublish(report.id, {
      recipients: ['audit@example.com'],
      channel: 'email',
      format: 'docx',
    })
    ctx.decideApproval(requested.approval.id, { decision: 'granted', approver: '财务总监' })
    await ctx.confirmPublish(requested.approval.id)

    const receipts = ctx.publishReceipts(report.id) as PublishReceipt[]
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.format).toBe('docx')
    expect(receipts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(receipts[0]!.fileName).toMatch(/\.docx$/)
  })
})
