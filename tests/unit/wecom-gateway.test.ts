import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode } from '@datasentry/core'
import { CredentialManager } from '@datasentry/backend/credentials/manager.ts'
import {
  publishGatewayHandlers,
  readReceipts,
} from '@datasentry/backend/sources/local-handlers/publish-gateway.ts'
import { startWecomSink, type WecomSink } from '../../scripts/wecom-sink.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

/**
 * 企微群机器人投递：真实 HTTP 协议，本地兼容服务接住。
 * 和邮件一样，这里验证的是「请求形状对不对、失败时会不会留下可重发的洞」。
 */

let temp: TempPaths
let sink: WecomSink
let credentials: CredentialManager
let receiptsFile: string
let artifactPath: string
let artifactSha: string
let artifactSize: number

const SECRET = 'test-webhook-key'

beforeEach(async () => {
  temp = tempPaths('datasentry-im-')
  sink = await startWecomSink()
  process.env['DATASENTRY_IM_BASE_URL'] = `http://127.0.0.1:${sink.port}`
  process.env['DATASENTRY_CRED_WECOM_TEST'] = SECRET
  credentials = CredentialManager.load(temp.paths)

  const artifacts = join(temp.paths.data, 'artifacts')
  mkdirSync(artifacts, { recursive: true })
  artifactPath = join(artifacts, 'report.xlsx')
  const bytes = Buffer.from('fake-xlsx-bytes')
  writeFileSync(artifactPath, bytes)
  artifactSha = createHash('sha256').update(bytes).digest('hex')
  artifactSize = bytes.length

  receiptsFile = join(temp.paths.data, 'published', 'receipts.jsonl')
})

afterEach(async () => {
  await sink.close()
  delete process.env['DATASENTRY_IM_BASE_URL']
  delete process.env['DATASENTRY_CRED_WECOM_TEST']
  temp.cleanup()
})

function argsFor(overrides: Record<string, unknown> = {}) {
  return {
    reportId: 'rpt_im',
    draftVersion: 'v1-im',
    recipients: ['board-room'],
    channel: 'im',
    format: 'xlsx',
    fileName: 'report.xlsx',
    artifactPath,
    sha256: artifactSha,
    sizeBytes: artifactSize,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    period: '2025-09',
    workspaceName: '集团财务共享中心',
    imTarget: 'board-room',
    imCredentialKey: 'WECOM_TEST',
    ...overrides,
  }
}

function ctx() {
  return {
    options: { file: receiptsFile },
    paths: temp.paths,
    credentials,
  }
}

function errorCodeOf(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : null
}

describe('企微群机器人投递', () => {
  it('先发摘要，再上传文件、发文件消息，回执记 wecom-bot', async () => {
    const result = await publishGatewayHandlers['publish_report']!(argsFor(), ctx() as never)
    const data = result.data as Record<string, unknown>

    expect(data['transport']).toBe('wecom-bot')
    expect(data['imTarget']).toBe('board-room')
    expect(data['mediaId']).toBeTruthy()

    const kinds = sink.received.map((item) => item.kind)
    expect(kinds).toEqual(['markdown', 'upload', 'file'])

    const markdown = sink.received[0]!
    expect(markdown.content).toContain('rpt_im')
    expect(markdown.content).toContain('report.xlsx')

    // 上传的字节必须与产物一致——审批批的就是这几个字节。
    const upload = sink.received[1]!
    expect(upload.fileName).toBe('report.xlsx')
    expect(upload.sha256).toBe(artifactSha)
    expect(upload.sizeBytes).toBe(artifactSize)

    // 发的 file 消息引用的正是刚上传的 media_id
    expect(sink.received[2]!.mediaId).toBe(upload.mediaId)

    const receipts = readReceipts(receiptsFile)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]!.transport).toBe('wecom-bot')

    // webhook key 绝不能出现在落盘的回执里
    expect(readFileSync(receiptsFile, 'utf8')).not.toContain(SECRET)
  })

  it('重复投递返回原回执，不再发第二条', async () => {
    await publishGatewayHandlers['publish_report']!(argsFor(), ctx() as never)
    const before = sink.received.length

    const second = await publishGatewayHandlers['publish_report']!(argsFor(), ctx() as never)
    expect((second.data as Record<string, unknown>)['deduplicated']).toBe(true)
    expect(sink.received.length).toBe(before)
    expect(readReceipts(receiptsFile)).toHaveLength(1)
  })

  it('缺凭据时明确失败，不留意图也不留回执', async () => {
    delete process.env['DATASENTRY_CRED_WECOM_TEST']
    const missing = CredentialManager.load(temp.paths)
    const context = { options: { file: receiptsFile }, paths: temp.paths, credentials: missing }

    await expect(
      publishGatewayHandlers['publish_report']!(argsFor(), context as never),
    ).rejects.toSatisfy((err: unknown) => errorCodeOf(err) === ErrorCode.CREDENTIAL_MISSING)

    expect(sink.received).toHaveLength(0)
    expect(readReceipts(receiptsFile)).toHaveLength(0)

    const intentDir = join(temp.paths.data, 'published', 'intents')
    expect(existsSync(intentDir) ? readdirSync(intentDir) : []).toHaveLength(0)
  })

  it('企微返回非 0 errcode 时撤掉意图，允许重试', async () => {
    sink.failNext('upload', 40006)

    await expect(
      publishGatewayHandlers['publish_report']!(argsFor(), ctx() as never),
    ).rejects.toSatisfy((err: unknown) => errorCodeOf(err) === ErrorCode.TOOL_EXECUTION_FAILED)

    expect(readReceipts(receiptsFile)).toHaveLength(0)
    const intentDir = join(temp.paths.data, 'published', 'intents')
    expect(existsSync(intentDir) ? readdirSync(intentDir) : []).toHaveLength(0)

    // 移除故障后可以正常重试
    const retry = await publishGatewayHandlers['publish_report']!(argsFor(), ctx() as never)
    expect((retry.data as Record<string, unknown>)['transport']).toBe('wecom-bot')
    expect(readReceipts(receiptsFile)).toHaveLength(1)
  })
})
