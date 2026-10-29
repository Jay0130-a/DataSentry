import { createHash } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { ErrorCode, hashValue, newId } from '@datasentry/core'
import { composeReportMail } from '../../email/compose.ts'
import { sendMail } from '../../email/sender.ts'
import { composeImSummary } from '../../im/summary.ts'
import { sendWecomFile, wecomBaseUrlOf } from '../../im/wecom.ts'
import { ToolExecutionError } from '../transports/types.ts'
import type { LocalToolHandlerMap } from '../transports/local.ts'

export interface PublishReceipt {
  receiptId: string
  reportId: string
  draftVersion: string
  recipients: string[]
  channel: string
  /** 发布格式：xlsx / docx / pdf / md */
  format: string
  fileName: string
  /** 文件内容摘要——「发出去的是哪几个字节」的凭据 */
  sha256: string
  sizeBytes: number
  mimeType: string
  /** 网关投递仓库里的落点 */
  deliveredPath: string
  /**
   * 实际投递方式。
   *
   * `smtp` 是真的发出去了；`stream` 只在测试里落盘（不联网）；
   * `simulated` 是 im / portal 这类尚未接真实渠道的占位。
   */
  transport?: 'smtp' | 'stream' | 'simulated' | 'wecom-bot'
  /** 邮件报文 ID。仅 email 渠道有。 */
  messageId?: string
  /** 企微素材 ID（有效期 3 天）。仅 im 渠道有。 */
  mediaId?: string
  /** 企微群目标名。仅 im 渠道有。 */
  imTarget?: string
  publishedAt: string
  /** 去重键：(reportId, draftVersion, recipients, channel, format) 的稳定摘要。 */
  key: string
}

/** 读取全部回执。M4 的「结果未知时先查回执」走这条路。 */
export function readReceipts(file: string): PublishReceipt[] {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const out: PublishReceipt[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as PublishReceipt)
    } catch {
      // 坏行不阻塞查询：回执是审计产物，读不出来时宁可少一条也不要整体失败
    }
  }
  return out
}

/** 单个报表的回执，按发布时间升序。 */
export function receiptsForReport(file: string, reportId: string): PublishReceipt[] {
  return readReceipts(file)
    .filter((receipt) => receipt.reportId === reportId)
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
}

export interface PublishDedupeInput {
  reportId: string
  draftVersion: string
  recipients: readonly string[]
  channel: string
  /** 格式进去重键：同一份内容以 Excel 和 PDF 发是两次投递。 */
  format: string
}

function normalizeRecipients(recipients: readonly string[]): string[] {
  return [...new Set(recipients.map((r) => r.trim().toLowerCase()))].sort()
}

/**
 * 投递去重键。
 *
 * 网关与后端**共用**这一个函数：幂等判定与「结果未知时查回执」必须算出同一个键，
 * 否则网关认为重复、后端却认为没发过，或者反过来。
 */
export function publishDedupeKey(input: PublishDedupeInput): string {
  return hashValue({
    reportId: input.reportId,
    draftVersion: input.draftVersion,
    recipients: normalizeRecipients(input.recipients),
    channel: input.channel,
    format: input.format,
  })
}

/** 按去重键查回执。这是「结果未知时先查回执」的入口。 */
export function findReceipt(file: string, key: string): PublishReceipt | undefined {
  return readReceipts(file).find((receipt) => receipt.key === key)
}

/**
 * 有没有「发出去了但没记账」的尝试。
 *
 * 有意图、没回执 = 结果未知：可能已经发出去，也可能没发成。
 * 只能转人工，不能当作「没发过」去重试。
 */
export function hasPublishIntent(receiptsFile: string, key: string): boolean {
  return existsSync(join(dirname(receiptsFile), 'intents', `${key}.json`))
}

/** 文件名只能是纯文件名——`../x`、`a/b` 这类值会把投递仓库的落点带出目录。 */
function assertSafeFileName(fileName: string): void {
  if (
    !fileName ||
    fileName === '.' ||
    fileName === '..' ||
    basename(fileName) !== fileName ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new ToolExecutionError(
      ErrorCode.SCHEMA_INVALID,
      `fileName 必须是纯文件名（不能包含路径分隔符或 ..）：${JSON.stringify(fileName)}`,
    )
  }
}

/**
 * 投递前复核文件本身。
 *
 * 审批绑定的是 sha256 承诺的那几个字节，网关是最后一道能证明「发出去的到底是哪份文件」
 * 的位置：路径必须落在产物目录内，摘要与大小必须由当前文件现算。上游 `confirmPublish`
 * 也做同样的检查，但网关是独立进程内 handler，不能假设调用方一定走过那条路径。
 */
function verifyArtifact(input: {
  artifactPath: string
  artifactsRoot: string
  sha256: string
  sizeBytes: number
}): string {
  mkdirSync(input.artifactsRoot, { recursive: true })

  let resolved: string
  try {
    resolved = realpathSync(input.artifactPath)
  } catch {
    throw new ToolExecutionError(
      ErrorCode.APPROVAL_PARAMS_DRIFT,
      `要发布的文件不存在或不可读：${input.artifactPath}`,
    )
  }

  const root = realpathSync(input.artifactsRoot)
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new ToolExecutionError(
      ErrorCode.SCHEMA_INVALID,
      `artifactPath 必须位于产物目录内：${input.artifactPath}`,
    )
  }

  const bytes = readFileSync(resolved)
  const actualSha = createHash('sha256').update(bytes).digest('hex')
  if (actualSha !== input.sha256) {
    throw new ToolExecutionError(
      ErrorCode.APPROVAL_PARAMS_DRIFT,
      `待发布文件的内容与审批绑定的摘要不一致（绑定 ${input.sha256.slice(0, 12)}…，实算 ${actualSha.slice(0, 12)}…）`,
    )
  }
  if (bytes.length !== input.sizeBytes) {
    throw new ToolExecutionError(
      ErrorCode.APPROVAL_PARAMS_DRIFT,
      `待发布文件大小与绑定不一致（绑定 ${input.sizeBytes} 字节，实际 ${bytes.length} 字节）`,
    )
  }
  return resolved
}

/**
 * 模拟报表发布网关。
 *
 * 除幂等去重与「把文件放进投递仓库」之外它什么也不做——但这两件正是这里需要的：
 * 发布流程的正确性全在上游（二次确认、绑定校验、接收人范围），
 * 网关只要保证「同样的东西不会投两次」以及「投出去的是这一份」。
 *
 * 回执写进 `data/published/receipts.jsonl`，是真文件、可被外部审计读取。
 */
export const publishGatewayHandlers: LocalToolHandlerMap = {
  async publish_report(args, ctx) {
    const file = String(ctx.options['file'] ?? '')
    if (!file) throw new Error('publish-gateway 缺少 options.file')

    const reportId = String(args['reportId'])
    const draftVersion = String(args['draftVersion'])
    const recipients = normalizeRecipients((args['recipients'] as unknown[]).map(String))
    const channel = String(args['channel'])
    const format = String(args['format'])
    const fileName = String(args['fileName'])
    const artifactPath = String(args['artifactPath'])
    const sha256 = String(args['sha256'])
    const sizeBytes = Number(args['sizeBytes'])
    const mimeType = String(args['mimeType'])

    assertSafeFileName(fileName)

    const key = publishDedupeKey({ reportId, draftVersion, recipients, channel, format })

    const existing = findReceipt(file, key)
    if (existing) {
      return {
        // 去重命中：返回原回执，不再次投递（见 sources/publish/guide.md）。
        data: { ...stripKey(existing), deduplicated: true },
        meta: {
          dataVersion: receiptsVersion(file),
          completeness: 'full' as const,
          rowCount: 1,
          deduplicated: true,
        },
      }
    }

    /*
     * 「尝试过但没留下回执」和「从没发过」必须分开。
     *
     * 真实渠道下，发送请求可能已经到达对方，只是我们没来得及记账。
     * 这时若允许重发，同一份报表就会发两次——邮件是收不回来的。
     * 留一条意图记录，让下一次调用停下来等人核对。
     */
    const intentDir = join(dirname(file), 'intents')
    const intentPath = join(intentDir, `${key}.json`)
    if (existsSync(intentPath)) {
      throw new ToolExecutionError(
        ErrorCode.RECEIPT_UNKNOWN,
        `上一次投递（${key.slice(0, 12)}…）没有留下回执，无法确定是否已发出；请人工核对后再决定是否重发`,
        { key },
      )
    }

    // 走到这里说明不是去重命中：真正投递前先证明「发出去的是审批绑定的那份文件」。
    const verifiedArtifactPath = verifyArtifact({
      artifactPath,
      artifactsRoot: ctx.paths.artifacts,
      sha256,
      sizeBytes,
    })

    let transport: PublishReceipt['transport'] = 'simulated'
    let messageId: string | null = null
    let mediaId: string | undefined
    let imTarget: string | undefined

    // 只有真实渠道才有「发出去了但没记账」的窗口，模拟渠道不需要意图记录。
    const isRealChannel = channel === 'email' || channel === 'im'

    if (isRealChannel) {
      // 先落意图再发：进程在发送途中死掉时，这条记录就是「结果未知」的证据。
      mkdirSync(intentDir, { recursive: true })
      writeFileSync(
        intentPath,
        JSON.stringify({
          key,
          at: new Date().toISOString(),
          reportId,
          draftVersion,
          recipients,
          channel,
          format,
        }),
        'utf8',
      )

      try {
        if (channel === 'email') {
          const composed = composeReportMail({
            reportId,
            draftVersion,
            fileName,
            format,
            ...(typeof args['workspaceName'] === 'string'
              ? { workspaceName: args['workspaceName'] }
              : {}),
            ...(typeof args['period'] === 'string' ? { period: args['period'] } : {}),
          })

          const sent = await sendMail(
            {
              to: recipients,
              subject: composed.subject,
              text: composed.text,
              attachments: [{ filename: fileName, path: verifiedArtifactPath, contentType: mimeType }],
            },
            ctx.paths,
          )
          transport = sent.transport
          messageId = sent.messageId
        } else {
          const targetName = String(args['imTarget'] ?? '')
          const credentialKey = String(args['imCredentialKey'] ?? '')
          if (!targetName || !credentialKey) {
            throw new ToolExecutionError(
              ErrorCode.CREDENTIAL_MISSING,
              'IM 投递缺少群目标或凭据变量名',
            )
          }

          // 密钥只在这里读一次，不进 args、事件或日志。
          const webhookKey = ctx.credentials?.get(credentialKey)
          if (!webhookKey) {
            throw new ToolExecutionError(
              ErrorCode.CREDENTIAL_MISSING,
              `缺少 IM 凭据 "${credentialKey}"`,
              { credentialKey },
            )
          }

          const sent = await sendWecomFile({
            baseUrl: wecomBaseUrlOf(),
            webhookKey,
            filePath: verifiedArtifactPath,
            fileName,
            summaryMarkdown: composeImSummary({
              reportId,
              draftVersion,
              fileName,
              sizeBytes,
              ...(typeof args['workspaceName'] === 'string'
                ? { workspaceName: args['workspaceName'] }
                : {}),
              ...(typeof args['period'] === 'string' ? { period: args['period'] } : {}),
            }),
          })

          transport = 'wecom-bot'
          mediaId = sent.mediaId
          imTarget = targetName
        }
      } catch (err) {
        // 明确失败（对方拒绝、连不上、缺凭据）：撤掉意图，允许重试。
        rmSync(intentPath, { force: true })
        if (err instanceof ToolExecutionError) throw err
        throw new ToolExecutionError(
          ErrorCode.TOOL_EXECUTION_FAILED,
          `${channel === 'email' ? '邮件' : 'IM '}投递失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 投递仓库留一份：无论真实发送还是模拟渠道，落点与字节都要能复核。
    const outDir = join(dirname(file), reportId)
    mkdirSync(outDir, { recursive: true })
    const deliveredPath = join(outDir, fileName)
    copyFileSync(verifiedArtifactPath, deliveredPath)

    const receipt: PublishReceipt = {
      receiptId: newId('rcpt'),
      reportId,
      draftVersion,
      recipients,
      channel,
      format,
      fileName,
      sha256,
      sizeBytes,
      mimeType,
      deliveredPath,
      transport,
      ...(messageId ? { messageId } : {}),
      ...(mediaId ? { mediaId } : {}),
      ...(imTarget ? { imTarget } : {}),
      publishedAt: new Date().toISOString(),
      key,
    }

    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(receipt)}\n`, 'utf8')

    /*
     * 回执落盘之后才撤意图。
     *
     * 顺序反过来会留下一个洞：发信成功 → 删意图 → 进程死 → 回执没写。
     * 下次恢复时既没有回执也没有意图，就会被判成「没发过」而重发一遍。
     * 现在中间任何一步失败，意图都还在，下一次调用会以 RECEIPT_UNKNOWN
     * 停下来等人核对。
     */
    if (isRealChannel) rmSync(intentPath, { force: true })

    return {
      data: { ...stripKey(receipt), deduplicated: false },
      meta: {
        dataVersion: receiptsVersion(file),
        completeness: 'full' as const,
        rowCount: 1,
        deduplicated: false,
      },
    }
  },
}

/** 回执里不对外暴露去重键，但保留在文件里供幂等判定。 */
function stripKey(receipt: PublishReceipt): Omit<PublishReceipt, 'key'> & Record<string, unknown> {
  const { key: _key, ...rest } = receipt
  return rest
}

function receiptsVersion(file: string): string {
  return `publish:${hashValue(readReceipts(file).map((r) => r.key)).slice(0, 12)}`
}
