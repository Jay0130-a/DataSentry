import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  hashValue,
  newReportId,
  reportArtifactSchema,
  type Conflict,
  type DataPaths,
  type MetricValue,
  type Report,
  type ReportArtifact,
  type ToolResult,
} from '@datasentry/core'
import type { CredentialManager } from '../credentials/manager.ts'

export interface BuildDraftInput {
  sessionId: string
  workspaceId: string
  period: string
  currency: string
  ruleVersion: string
  metrics: readonly MetricValue[]
  conflicts: readonly Conflict[]
  results: readonly ToolResult[]
  warnings: readonly string[]
}

/**
 * 生成报表草稿（PRD §5 流程末端）。
 *
 * 同时落三样东西：
 * - `draft-v1.json` —— 结构化产物，回归脚本断言它
 * - `draft-v1.md`   —— 人能直接读的报表
 * - `report` 表一行 —— 给 API 与后续发布流程用
 *
 * `draftVersion` 取产物内容的摘要，而不是递增的数字：内容不变时版本就不变，
 * 「接收人变了但草稿没变」这类情况才能被正确区分（FR-06.2 的绑定依赖它）。
 */
export interface DraftArtifactStore {
  dir: string
  jsonPath: string
  markdownPath: string
}

export function artifactDir(sessionId: string, paths: DataPaths): string {
  return join(paths.artifacts, sessionId)
}

export function writeDraft(
  input: BuildDraftInput,
  paths: DataPaths,
  credentials?: CredentialManager,
): { artifact: ReportArtifact; store: DraftArtifactStore; report: Report } {
  const dir = artifactDir(input.sessionId, paths)
  mkdirSync(dir, { recursive: true })

  const generatedAt = new Date().toISOString()
  const sources = input.results.map((r) => ({
    slug: r.sourceRef.slug,
    resultId: r.resultId,
    dataVersion: r.sourceRef.dataVersion,
    completeness: r.completeness,
  }))

  const draftVersion = `v1-${hashValue({
    metrics: input.metrics,
    sources,
    period: input.period,
    ruleVersion: input.ruleVersion,
  }).slice(0, 12)}`

  const artifactInput = {
    reportId: newReportId(),
    sessionId: input.sessionId,
    draftVersion,
    ruleVersion: input.ruleVersion,
    period: input.period,
    currency: input.currency,
    generatedAt,
    metrics: [...input.metrics],
    conflicts: [...input.conflicts],
    sources,
    warnings: [...input.warnings],
  }

  // 凭据清洗是最后一道出口过滤：报表产物绝不能带上任何凭据值。
  const artifact = reportArtifactSchema.parse(
    credentials ? credentials.scrubValue(artifactInput) : artifactInput,
  )

  const jsonPath = join(dir, 'draft-v1.json')
  const markdownPath = join(dir, 'draft-v1.md')
  writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  writeFileSync(markdownPath, renderMarkdown(artifact), 'utf8')

  const report: Report = {
    id: artifact.reportId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    draftVersion,
    status: 'draft',
    ruleVersion: input.ruleVersion,
    metrics: [...input.metrics],
    conflicts: [...input.conflicts],
    resultRefs: input.results.map((r) => r.resultId),
    dataVersions: Object.fromEntries(sources.map((s) => [s.slug, s.dataVersion])),
    recipientsHash: null,
    receiptId: null,
    artifactPath: jsonPath,
    meta: { period: input.period, warnings: [...input.warnings] },
    createdAt: generatedAt,
    updatedAt: generatedAt,
  }

  return { artifact, store: { dir, jsonPath, markdownPath }, report }
}

function formatAmount(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatValue(metric: MetricValue, currency: string): string {
  if (metric.unit === '比率') return `${(metric.value * 100).toFixed(2)}%`
  if (metric.unit === '笔') return `${metric.value.toLocaleString('zh-CN')} 笔`
  return formatAmount(metric.value, currency)
}

/**
 * 人工可读的报表。
 *
 * 刻意**不**把明细行铺进来：经营月报是汇总口径，费用明细属机密数据，
 * 只允许以汇总形式出现（见 sources/finance/guide.md 的敏感数据约定）。
 */
export function renderMarkdown(artifact: ReportArtifact): string {
  const lines: string[] = []
  lines.push(`# 经营月报 · ${artifact.period}`)
  lines.push('')
  lines.push(`- 报表编号：\`${artifact.reportId}\``)
  lines.push(`- 草稿版本：\`${artifact.draftVersion}\``)
  lines.push(`- 指标规则版本：\`${artifact.ruleVersion}\``)
  lines.push(`- 生成时间：${artifact.generatedAt}`)
  lines.push(`- 币种：${artifact.currency}`)
  lines.push('')

  lines.push('## 核心指标')
  lines.push('')
  lines.push('| 指标 | 数值 | 口径 | 完整性 |')
  lines.push('|---|---:|---|---|')
  for (const metric of artifact.metrics) {
    lines.push(
      `| ${metric.label} | ${formatValue(metric, artifact.currency)} | ${metric.formula} | ${metric.completeness} |`,
    )
  }
  lines.push('')

  lines.push('## 数据来源')
  lines.push('')
  lines.push('| 数据源 | 结果编号 | 数据版本 | 完整性 |')
  lines.push('|---|---|---|---|')
  for (const source of artifact.sources) {
    lines.push(
      `| ${source.slug} | \`${source.resultId}\` | \`${source.dataVersion}\` | ${source.completeness} |`,
    )
  }
  lines.push('')

  if (artifact.conflicts.length > 0) {
    lines.push('## 口径冲突（需人工判定）')
    lines.push('')
    for (const conflict of artifact.conflicts) {
      lines.push(`- **${conflict.metricKey}**：${conflict.description}`)
      for (const candidate of conflict.candidates) {
        lines.push(`  - ${candidate.sourceSlug}：${candidate.value}（\`${candidate.resultId}\`）`)
      }
    }
    lines.push('')
  }

  if (artifact.warnings.length > 0) {
    lines.push('## 注脚与告警')
    lines.push('')
    for (const warning of artifact.warnings) lines.push(`- ${warning}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('本报表由 DataSentry 生成。正式发布前需人工二次确认。')
  lines.push('')
  return lines.join('\n')
}

/** 工具结果落盘，作为检查点的 `output_ref`。 */
export function writeToolResult(
  sessionId: string,
  result: ToolResult,
  paths: DataPaths,
  credentials?: CredentialManager,
): string {
  const dir = join(artifactDir(sessionId, paths), 'results')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${result.resultId}.json`)
  const payload = credentials ? credentials.scrubValue(result) : result
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return file
}

/**
 * 把落盘的取数结果读回来。
 *
 * 恢复执行时用它重建 Agent 的记忆：内存里的结果早就没了，但磁盘上还在，
 * 而且磁盘上的那份才是当时真正用于计算的东西。
 */
export function readToolResult(
  sessionId: string,
  resultId: string,
  paths: DataPaths,
): ToolResult | undefined {
  const file = join(artifactDir(sessionId, paths), 'results', `${resultId}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ToolResult
  } catch {
    return undefined
  }
}
