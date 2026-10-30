import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCode } from '@datasentry/core'
import { publishGatewayHandlers, isDefinitelyNotDelivered } from '@datasentry/backend/sources/local-handlers/publish-gateway.ts'
import { ToolExecutionError } from '@datasentry/backend/sources/transports/types.ts'
import { WecomError } from '@datasentry/backend/im/wecom.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

/**
 * 网关是发布链路的最后一道执行点。它不能假设调用方一定走过 `confirmPublish`：
 * 文件摘要、大小、落点都必须由它自己按当前文件现算。
 */
describe('发布网关：投递前复核文件', () => {
  let temp: TempPaths
  let receiptsFile: string
  let artifactPath: string

  const CONTENT = 'report-bytes-v1'

  function baseArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const bytes = readFileSync(artifactPath)
    return {
      reportId: 'rpt_gateway',
      draftVersion: 'v1',
      recipients: ['board@example.com'],
      channel: 'portal',
      format: 'xlsx',
      fileName: 'report.xlsx',
      artifactPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ...overrides,
    }
  }

  async function expectCode(
    args: Record<string, unknown>,
    code: ErrorCode,
  ): Promise<void> {
    try {
      await publishGatewayHandlers.publish_report!(args, {
        options: { file: receiptsFile },
        paths: temp.paths,
      })
      throw new Error(`本应抛出 ${code}`)
    } catch (err) {
      expect(err).toBeInstanceOf(ToolExecutionError)
      expect((err as ToolExecutionError).code).toBe(code)
    }
  }

  beforeEach(() => {
    temp = tempPaths('datasentry-gateway-')
    mkdirSync(temp.paths.artifacts, { recursive: true })
    receiptsFile = join(temp.paths.data, 'published', 'receipts.jsonl')
    artifactPath = join(temp.paths.artifacts, 'report.xlsx')
    writeFileSync(artifactPath, CONTENT, 'utf8')
  })

  afterEach(() => {
    temp.cleanup()
  })

  it('文件与绑定一致时正常投递', async () => {
    const result = await publishGatewayHandlers.publish_report!(baseArgs(), {
      options: { file: receiptsFile },
      paths: temp.paths,
    })

    const data = result.data as { receiptId: string; deduplicated: boolean }
    expect(data.receiptId).toBeTruthy()
    expect(data.deduplicated).toBe(false)
  })

  it('文件字节被替换后拒绝投递', async () => {
    const args = baseArgs()
    // 等长替换：只有 sha256 能发现，sizeBytes 检查发现不了。
    writeFileSync(artifactPath, 'report-bytes-v2', 'utf8')
    await expectCode(args, ErrorCode.APPROVAL_PARAMS_DRIFT)
  })

  it('sizeBytes 与真实文件不一致时拒绝投递', async () => {
    await expectCode(baseArgs({ sizeBytes: 999 }), ErrorCode.APPROVAL_PARAMS_DRIFT)
  })

  it('fileName 带路径分隔符时拒绝投递', async () => {
    await expectCode(baseArgs({ fileName: '../evil.xlsx' }), ErrorCode.SCHEMA_INVALID)
    await expectCode(baseArgs({ fileName: 'sub/evil.xlsx' }), ErrorCode.SCHEMA_INVALID)
  })

  it('fileName 是 Windows 保留名/数据流/结尾点号时拒绝投递', async () => {
    await expectCode(baseArgs({ fileName: 'NUL' }), ErrorCode.SCHEMA_INVALID)
    await expectCode(baseArgs({ fileName: 'COM1.xlsx' }), ErrorCode.SCHEMA_INVALID)
    await expectCode(baseArgs({ fileName: 'report.xlsx:stream' }), ErrorCode.SCHEMA_INVALID)
    await expectCode(baseArgs({ fileName: 'report.xlsx.' }), ErrorCode.SCHEMA_INVALID)
  })

  it('reportId 带路径分隔符时拒绝投递', async () => {
    await expectCode(baseArgs({ reportId: '../../evil' }), ErrorCode.SCHEMA_INVALID)
    await expectCode(baseArgs({ reportId: 'sub/evil' }), ErrorCode.SCHEMA_INVALID)
  })

  it('artifactPath 越出产物目录时拒绝投递', async () => {
    const outside = join(temp.paths.data, 'outside.xlsx')
    writeFileSync(outside, CONTENT, 'utf8')
    const bytes = readFileSync(outside)
    await expectCode(
      {
        ...baseArgs(),
        artifactPath: outside,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      ErrorCode.SCHEMA_INVALID,
    )
  })

  it('产物目录内以 .. 开头的合法子目录不会被误杀', async () => {
    const dir = join(temp.paths.artifacts, '..cache')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'report.xlsx')
    writeFileSync(path, CONTENT, 'utf8')
    const bytes = readFileSync(path)

    const result = await publishGatewayHandlers.publish_report!(
      baseArgs({
        reportId: 'rpt_dotdot_cache',
        artifactPath: path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
      { options: { file: receiptsFile }, paths: temp.paths },
    )
    expect((result.data as { receiptId: string }).receiptId).toBeTruthy()
  })

  it('artifactPath 指向目录时按文件不可读处理', async () => {
    const dir = join(temp.paths.artifacts, 'a-directory')
    mkdirSync(dir, { recursive: true })
    await expectCode(
      baseArgs({ artifactPath: dir }),
      ErrorCode.APPROVAL_PARAMS_DRIFT,
    )
  })

  it('文件不存在时拒绝投递', async () => {
    await expectCode(
      baseArgs({ artifactPath: join(temp.paths.artifacts, 'missing.xlsx') }),
      ErrorCode.APPROVAL_PARAMS_DRIFT,
    )
  })
})

describe('intent 只在能证明未发出时撤销', () => {
  function withCode(code: string): Error {
    return Object.assign(new Error(code), { code })
  }

  it('连接拒绝、DNS、认证、信封错误视为明确未发出', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAUTH', 'EENVELOPE']) {
      expect(isDefinitelyNotDelivered(withCode(code), 'email')).toBe(true)
    }
    // nodemailer 把连接拒绝包成 ESOCKET，真错误在 message 里
    expect(
      isDefinitelyNotDelivered(
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
          code: 'ESOCKET',
          command: 'CONN',
        }),
        'email',
      ),
    ).toBe(true)
    // 只有 CONN 标记、没有连接拒绝证据：可能是 DATA 之后的 socket 中断
    expect(
      isDefinitelyNotDelivered(
        Object.assign(new Error('socket hang up'), { code: 'ESOCKET', command: 'CONN' }),
        'email',
      ),
    ).toBe(false)
  })

  it('超时、socket 中断、未知错误视为结果未知', () => {
    for (const code of ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'EPIPE']) {
      expect(isDefinitelyNotDelivered(withCode(code), 'email')).toBe(false)
    }
    expect(isDefinitelyNotDelivered(new Error('boom'), 'email')).toBe(false)
  })

  it('企微平台 errcode 视为未发出，网络错误/系统繁忙视为未知', () => {
    expect(isDefinitelyNotDelivered(new WecomError('summary', -1, 'bad gateway'), 'im')).toBe(true)
    expect(isDefinitelyNotDelivered(new WecomError('upload', 40001, 'bad key'), 'im')).toBe(true)
    // -1：非 JSON / 系统繁忙，无法确定文件是否发出
    expect(isDefinitelyNotDelivered(new WecomError('send', -1, 'bad gateway'), 'im')).toBe(false)
    expect(isDefinitelyNotDelivered(new Error('network down'), 'im')).toBe(false)
    expect(isDefinitelyNotDelivered(withCode('ECONNREFUSED'), 'im')).toBe(true)
  })

  it('ToolExecutionError 是明确的前置失败', () => {
    expect(
      isDefinitelyNotDelivered(
        new ToolExecutionError(ErrorCode.CREDENTIAL_MISSING, '缺少凭据'),
        'email',
      ),
    ).toBe(true)
  })

  it('fetch 把错误码放在 cause 上也能识别', () => {
    const err = new TypeError('fetch failed') as TypeError & { cause?: unknown }
    err.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    expect(isDefinitelyNotDelivered(err, 'im')).toBe(true)
    expect(isDefinitelyNotDelivered(err, 'email')).toBe(true)
  })
})
