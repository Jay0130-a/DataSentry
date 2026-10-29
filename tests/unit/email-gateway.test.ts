import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode } from '@datasentry/core'
import { composeReportMail } from '@datasentry/backend/email/compose.ts'
import {
  publishDedupeKey,
  publishGatewayHandlers,
  readReceipts,
} from '@datasentry/backend/sources/local-handlers/publish-gateway.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths | null = null

/** ToolExecutionError 不是 DataSentryError 的子类，直接按 code 断言。 */
function errorCodeOf(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : null
}

afterEach(() => {
  temp?.cleanup()
  temp = null
})

function setup(): {
  receiptsFile: string
  artifactPath: string
  ctx: { options: Record<string, unknown>; paths: TempPaths['paths'] }
} {
  temp = tempPaths('datasentry-mail-')
  const artifacts = join(temp.paths.data, 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  const artifactPath = join(artifacts, 'report.md')
  writeFileSync(artifactPath, '# 经营月报\n')

  const receiptsFile = join(temp.paths.data, 'published', 'receipts.jsonl')
  return {
    receiptsFile,
    artifactPath,
    ctx: { options: { file: receiptsFile }, paths: temp.paths },
  }
}

function argsFor(artifactPath: string, overrides: Record<string, unknown> = {}) {
  const bytes = readFileSync(artifactPath)
  return {
    reportId: 'rpt_test',
    draftVersion: 'v1-abc',
    recipients: ['board@example.com'],
    channel: 'email',
    format: 'md',
    fileName: 'report.md',
    artifactPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    mimeType: 'text/markdown',
    period: '2025-09',
    workspaceName: '集团财务共享中心',
    ...overrides,
  }
}

describe('邮件标题与正文', () => {
  it('有期间和工作区时标题可读', () => {
    const mail = composeReportMail({
      reportId: 'rpt_1',
      draftVersion: 'v1-abc',
      fileName: 'report.xlsx',
      format: 'xlsx',
      period: '2025-09',
      workspaceName: '集团财务共享中心',
    })
    expect(mail.subject).toBe('【集团财务共享中心】2025-09 经营报表')
    expect(mail.text).toContain('报表编号：rpt_1')
    expect(mail.text).toContain('文件：report.xlsx（XLSX）')
  })

  it('缺期间和工作区时退化成可辨认的标题', () => {
    const mail = composeReportMail({
      reportId: 'rpt_2',
      draftVersion: 'v1-def',
      fileName: 'report.md',
      format: 'md',
    })
    expect(mail.subject).toBe('【DataSentry】报表 rpt_2')
  })
})

describe('发布网关：真实邮件路径', () => {
  it('email 渠道会组装报文并落盘，回执带 transport 与 messageId', async () => {
    const { receiptsFile, artifactPath, ctx } = setup()

    const result = await publishGatewayHandlers['publish_report']!(
      argsFor(artifactPath),
      ctx as never,
    )
    const data = result.data as Record<string, unknown>

    expect(data['transport']).toBe('stream')
    expect(String(data['messageId'])).toContain('@')

    const files = readdirSync(temp!.paths.mail)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.eml$/)

    const receipts = readReceipts(receiptsFile)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.transport).toBe('stream')

    // 成功后意图必须清掉，否则下一次会被自己挡住。
    const intentDir = join(temp!.paths.data, 'published', 'intents')
    expect(existsSync(intentDir) ? readdirSync(intentDir) : []).toHaveLength(0)
  })

  it('重复投递返回原回执，不产生第二封信', async () => {
    const { receiptsFile, artifactPath, ctx } = setup()
    const args = argsFor(artifactPath)

    await publishGatewayHandlers['publish_report']!(args, ctx as never)
    const second = await publishGatewayHandlers['publish_report']!(args, ctx as never)

    expect((second.data as Record<string, unknown>)['deduplicated']).toBe(true)
    expect(readReceipts(receiptsFile)).toHaveLength(1)
    expect(readdirSync(temp!.paths.mail)).toHaveLength(1)
  })

  it('有意图没回执时拒绝重发：结果未知不能当没发过', async () => {
    const { receiptsFile, artifactPath, ctx } = setup()
    const args = argsFor(artifactPath)
    const key = publishDedupeKey({
      reportId: 'rpt_test',
      draftVersion: 'v1-abc',
      recipients: ['board@example.com'],
      channel: 'email',
      format: 'md',
    })

    const intentDir = join(temp!.paths.data, 'published', 'intents')
    mkdirSync(intentDir, { recursive: true })
    writeFileSync(join(intentDir, `${key}.json`), JSON.stringify({ key }))

    await expect(
      publishGatewayHandlers['publish_report']!(args, ctx as never),
    ).rejects.toSatisfy((err: unknown) => errorCodeOf(err) === ErrorCode.RECEIPT_UNKNOWN)
  })

  it('SMTP 明确失败时撤掉意图，允许重试', async () => {
    const { receiptsFile, artifactPath, ctx } = setup()
    const previousMode = process.env['DATASENTRY_SMTP_MODE']
    const previousPort = process.env['DATASENTRY_SMTP_PORT']

    process.env['DATASENTRY_SMTP_MODE'] = 'smtp'
    process.env['DATASENTRY_SMTP_PORT'] = '1' // 必然连接被拒

    try {
      await expect(
        publishGatewayHandlers['publish_report']!(argsFor(artifactPath), ctx as never),
      ).rejects.toSatisfy(
        (err: unknown) => errorCodeOf(err) === ErrorCode.TOOL_EXECUTION_FAILED,
      )

      const intentDir = join(temp!.paths.data, 'published', 'intents')
      const leftover = existsSync(intentDir) ? readdirSync(intentDir) : []
      expect(leftover).toHaveLength(0)
      expect(readReceipts(receiptsFile)).toHaveLength(0)
    } finally {
      if (previousMode === undefined) delete process.env['DATASENTRY_SMTP_MODE']
      else process.env['DATASENTRY_SMTP_MODE'] = previousMode
      if (previousPort === undefined) delete process.env['DATASENTRY_SMTP_PORT']
      else process.env['DATASENTRY_SMTP_PORT'] = previousPort
    }
  })

  it('发信成功但回执写失败时保留意图，下一次不得重发', async () => {
    const { receiptsFile, artifactPath, ctx } = setup()

    // 把投递仓库里的目标路径先占成一个目录 → copyFileSync 必然失败。
    // 这模拟的是「信已经发出去了，但本地记账没走完」。
    const outDir = join(temp!.paths.data, 'published', 'rpt_test')
    mkdirSync(outDir, { recursive: true })
    mkdirSync(join(outDir, 'report.md'), { recursive: true })

    await expect(
      publishGatewayHandlers['publish_report']!(argsFor(artifactPath), ctx as never),
    ).rejects.toBeTruthy()

    // 信确实已经发出去了（stream 模式落了盘），但没有回执。
    expect(readdirSync(temp!.paths.mail)).toHaveLength(1)
    expect(readReceipts(receiptsFile)).toHaveLength(0)

    // 意图必须还在——这正是「结果未知」的证据。
    const key = publishDedupeKey({
      reportId: 'rpt_test',
      draftVersion: 'v1-abc',
      recipients: ['board@example.com'],
      channel: 'email',
      format: 'md',
    })
    expect(existsSync(join(temp!.paths.data, 'published', 'intents', `${key}.json`))).toBe(true)

    // 再投一次必须被拒，而不是静悄悄发第二封。
    await expect(
      publishGatewayHandlers['publish_report']!(argsFor(artifactPath), ctx as never),
    ).rejects.toSatisfy((err: unknown) => errorCodeOf(err) === ErrorCode.RECEIPT_UNKNOWN)
    expect(readdirSync(temp!.paths.mail)).toHaveLength(1)
  })

  it('非 email 渠道保持模拟投递，不产生邮件', async () => {
    const { artifactPath, ctx } = setup()

    const result = await publishGatewayHandlers['publish_report']!(
      argsFor(artifactPath, { channel: 'portal' }),
      ctx as never,
    )

    expect((result.data as Record<string, unknown>)['transport']).toBe('simulated')
    expect(existsSync(temp!.paths.mail)).toBe(false)
  })
})
