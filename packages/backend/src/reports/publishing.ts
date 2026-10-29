import { hashValue, type Report } from '@datasentry/core'

export const PublishChannel = {
  EMAIL: 'email',
  IM: 'im',
  PORTAL: 'portal',
} as const

export type PublishChannel = (typeof PublishChannel)[keyof typeof PublishChannel]

export const PUBLISH_CHANNELS: readonly PublishChannel[] = Object.values(PublishChannel)

/**
 * 发布格式。
 *
 * 这是一个**会进审批绑定**的字段：批的是「把这份 Excel 发给这些人」，
 * 换成 PDF 就是另一件事，原确认应当失效。
 */
export const PublishFormat = {
  EXCEL: 'xlsx',
  WORD: 'docx',
  PDF: 'pdf',
  MARKDOWN: 'md',
} as const

export type PublishFormat = (typeof PublishFormat)[keyof typeof PublishFormat]

export const PUBLISH_FORMATS: readonly PublishFormat[] = Object.values(PublishFormat)

export const MIME_TYPES: Record<PublishFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
}

export function isPublishFormat(value: unknown): value is PublishFormat {
  return typeof value === 'string' && (PUBLISH_FORMATS as readonly string[]).includes(value)
}

export interface PublishRequest {
  recipients: readonly string[]
  channel: PublishChannel
  format: PublishFormat
}

export interface PublishPrecheckInput {
  report: Report
  /** 邮件 / 门户渠道的接收人名单。 */
  allowedRecipients: readonly string[]
  /** IM 渠道允许的群目标名；IM 用这一份，不用邮箱名单。 */
  imTargets?: readonly string[]
  request: PublishRequest
  /** 草稿产物里记录的告警，一并带进校验结论。 */
  warnings?: readonly string[]
}

export interface PublishPrecheck {
  ok: boolean
  failures: string[]
  warnings: string[]
  /** 规范化后的接收人：去重、去空白、小写、排序。 */
  recipients: string[]
}

/** 接收人与渠道的规范化。排序是为了让摘要稳定——审批绑定的是它。 */
export function normalizeRecipients(recipients: readonly string[]): string[] {
  return [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))].sort()
}

/**
 * 发布确认的绑定摘要（PRD FR-03.4 / FR-06.2）。
 *
 * 绑定的是**草稿版本 + 接收人 + 渠道 + 格式**。任何一项变化，摘要就变，
 * 原确认随之失效——「批的是这个版本、以这种格式、发给这些人」这句话，
 * 必须能被机器逐字核对。
 */
export function computeRecipientsHash(request: PublishRequest): string {
  return hashValue({
    recipients: normalizeRecipients(request.recipients),
    channel: request.channel,
    format: request.format,
  })
}

/**
 * 发布前置校验（PRD FR-06.1）。
 *
 * 检查的是**报表本身能不能发**：数据版本齐不齐、口径有没有冲突、
 * 草稿是不是还在草稿态、收件人在不在授权名单里。
 *
 * 至于「现在这个会话允许不允许发起发布」是流程问题，由 `PublishService.requestPublish`
 * 判断——放在这里会让「替换一份已有的发布确认」被误判成非法状态。
 */
export function precheckPublish(input: PublishPrecheckInput): PublishPrecheck {
  const failures: string[] = []
  const warnings: string[] = [...(input.warnings ?? [])]
  const recipients = normalizeRecipients(input.request.recipients)

  if (input.report.status !== 'draft') {
    failures.push(`报表当前状态为 ${input.report.status}，不能重复发布`)
  }

  if (recipients.length === 0) {
    failures.push('接收人为空')
  }

  if (!PUBLISH_CHANNELS.includes(input.request.channel)) {
    failures.push(`未知的投递渠道 "${input.request.channel}"`)
  }

  if (!isPublishFormat(input.request.format)) {
    failures.push(
      `未知的发布格式 "${String(input.request.format)}"，可选：${PUBLISH_FORMATS.join(' / ')}`,
    )
  }

  // 接收人范围：不在授权名单里的一个都不放过。
  // IM 与邮件的「接收人」不是同一类东西——群机器人只能发到它所属的那个群。
  const isIm = input.request.channel === 'im'
  const allowList = isIm ? (input.imTargets ?? []) : input.allowedRecipients
  const allowed = new Set(allowList.map((r) => r.trim().toLowerCase()))
  const unauthorized = recipients.filter((r) => !allowed.has(r))
  if (unauthorized.length > 0) {
    failures.push(
      `以下${isIm ? '目标' : '接收人'}不在当前 Workspace 的${isIm ? ' IM 目标' : '分发名单'}内：${unauthorized.join(', ')}` +
        (allowed.size > 0
          ? `（允许：${[...allowed].sort().join(', ')}）`
          : `（${isIm ? '未配置 IM 目标' : '名单为空'}，禁止对外发布）`),
    )
  }

  // 一个群机器人只属于一个群：一次发布只能指定一个目标，否则没法说清到底发到了哪。
  if (isIm && recipients.length > 1) {
    failures.push(`IM 渠道一次只能指定一个群目标（收到 ${recipients.length} 个：${recipients.join(', ')}）`)
  }

  // 有口径冲突的报表不能发布——数仓和 ERP 对不上的数字发给董事会是要出事的。
  if (input.report.conflicts.length > 0) {
    failures.push(
      `报表存在 ${input.report.conflicts.length} 处口径冲突未解决，不能发布：${input.report.conflicts
        .map((c) => c.metricKey)
        .join(', ')}`,
    )
  }

  for (const metric of input.report.metrics) {
    if (metric.completeness !== 'full') {
      warnings.push(
        `指标「${metric.label}」完整性为 ${metric.completeness}，发布后需在正文中标注`,
      )
    }
  }

  if (Object.keys(input.report.dataVersions).length === 0) {
    failures.push('报表没有记录任何数据版本，无法追溯发布的是哪一版数据')
  }

  return { ok: failures.length === 0, failures, warnings, recipients }
}
