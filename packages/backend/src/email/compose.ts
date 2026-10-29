export interface ReportMailInput {
  workspaceName?: string
  period?: string
  reportId: string
  draftVersion: string
  fileName: string
  format: string
}

/**
 * 邮件标题与正文。
 *
 * 刻意保持纯函数：标题和正文属于「人对人的表达」，不参与任何校验，
 * 也不该在网关里拼字符串——那样测不到。
 */
export function composeReportMail(input: ReportMailInput): { subject: string; text: string } {
  const period = input.period?.trim() ?? ''
  const workspaceName = input.workspaceName?.trim() ?? ''

  const subject = period || workspaceName
    ? `【${workspaceName || 'DataSentry'}】${period ? `${period} ` : ''}经营报表`
    : `【DataSentry】报表 ${input.reportId}`

  const lines = [
    '您好，',
    '',
    `附件是${workspaceName ? ` ${workspaceName}` : ''}${period ? ` ${period}` : ''} 的经营报表。`,
    '',
    `报表编号：${input.reportId}`,
    `草稿版本：${input.draftVersion}`,
    `文件：${input.fileName}（${input.format.toUpperCase()}）`,
    '',
    '本邮件由 DataSentry 在发布确认通过后自动发送。',
  ]

  return { subject, text: lines.join('\n') }
}
