export interface ImSummaryInput {
  workspaceName?: string
  period?: string
  reportId: string
  draftVersion: string
  fileName: string
  sizeBytes: number
}

/**
 * 发文件之前的那条摘要。
 *
 * 企微的 markdown 只支持有限语法（标题、加粗、链接、行内代码、引用、字体颜色），
 * 不支持表格和图片——所以这里只用它认得的写法。
 */
export function composeImSummary(input: ImSummaryInput): string {
  const title = [input.workspaceName, input.period].filter(Boolean).join(' · ')
  const size = `${(input.sizeBytes / 1024).toFixed(1)} KB`

  return [
    `**${title || '报表'} 已生成**`,
    `> 报表编号：\`${input.reportId}\``,
    `> 草稿版本：\`${input.draftVersion}\``,
    `> 文件：**${input.fileName}**（${size}）`,
    '',
    '文件随后发送，正式内容以附件为准。',
  ].join('\n')
}
