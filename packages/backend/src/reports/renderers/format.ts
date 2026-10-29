import type { ReportArtifact } from '@datasentry/core'

/**
 * 三种格式共用的展示格式化。
 *
 * 抽出来的目的只有一个：**同一个数字在 Excel / Word / PDF 里必须长得一样**。
 * 各自写一份 toFixed，迟早会出现「Excel 显示 31.65%，PDF 显示 0.3165」。
 */

export function formatMetric(metric: ReportArtifact['metrics'][number]): string {
  if (metric.unit === '比率') return `${(metric.value * 100).toFixed(2)}%`
  if (metric.unit === '笔') return metric.value.toLocaleString('zh-CN')
  return metric.value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatAmount(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function reportTitle(artifact: ReportArtifact): string {
  return `经营月报 · ${artifact.period}`
}

export function reportMetaLines(artifact: ReportArtifact): Array<[string, string]> {
  return [
    ['报表编号', artifact.reportId],
    ['草稿版本', artifact.draftVersion],
    ['指标规则版本', artifact.ruleVersion],
    ['生成时间', artifact.generatedAt],
    ['币种', artifact.currency],
  ]
}
