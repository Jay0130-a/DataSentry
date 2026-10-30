import { Completeness, type Conflict, type MetricValue, type ToolResult } from '@datasentry/core'
import { REQUIRED_METRICS } from './metrics.ts'

export { REQUIRED_METRICS }

export interface ValidationInput {
  results: readonly ToolResult[]
  metrics: readonly MetricValue[]
  conflicts: readonly Conflict[]
  /** 计算阶段已经产生的告警，一并汇总。 */
  warnings: readonly string[]
  /** 计算阶段的硬错误（例如指标输入匹配到多条结果）。 */
  errors?: readonly string[]
  /**
   * 必须具备的指标 key。
   *
   * 由 Workspace 的 `metrics.required` 提供；缺省时用内置的三项。
   * 不同报表类型可以要求不同的指标——把「什么是完整」也交回业务配置。
   */
  required?: readonly string[]
}

export interface ValidationOutcome {
  /** false 表示需要人工介入（MANUAL_REVIEW），而不是「程序出错」。 */
  ok: boolean
  failures: string[]
  warnings: string[]
}

/**
 * 完整性与口径冲突校验（PRD FR-06.1 的前置校验）。
 *
 * 这里刻意区分两类问题：
 * - **缺数据** → failure：报表不完整，不能出。
 * - **口径对不上** → failure 且转人工：不静默选一个数，也不因为「数仓更接近预期」就采信它。
 *
 * 而 `completeness: partial` 只算 warning 并写进报表注脚——部分口径在真实业务里
 * 是常态（某事业部未结账），把它当成硬失败会让系统没法用；但当成无事发生更糟。
 */
export function validateReport(input: ValidationInput): ValidationOutcome {
  const failures: string[] = [...(input.errors ?? [])]
  const warnings: string[] = [...input.warnings]

  const present = new Set(input.metrics.map((m) => m.key))
  const required = input.required ?? REQUIRED_METRICS
  for (const key of required) {
    if (!present.has(key)) {
      failures.push(`缺少必需指标：${key}`)
    }
  }

  if (input.metrics.length === 0) {
    failures.push('没有计算出任何指标，取数步骤可能全部未完成')
  }

  for (const conflict of input.conflicts) {
    failures.push(`口径冲突：${conflict.description}`)
  }

  for (const metric of input.metrics) {
    if (metric.completeness !== Completeness.FULL) {
      warnings.push(
        `指标「${metric.label}」的输入数据完整性为 ${metric.completeness}，报表需标注该口径不完整`,
      )
    }
  }

  // 这里统计的是**本次实际取过数的 Source**，不是 metrics.inputs 里出现的 Source。
  // monthly-crosscheck 的 reporting-db 结果用于人工核对、不进入指标公式，
  // 但它确实构成第二个数据源；按 metrics.inputs 统计会把这条正常路径判失败。
  // 真正的「指标输入是否跨源」需要单独配置，留待后续。
  const sourcesUsed = new Set(input.results.map((r) => r.sourceRef.slug))
  if (sourcesUsed.size < 2) {
    failures.push(
      `本次报表只用到 ${sourcesUsed.size} 个数据源，无法完成交叉核对（至少需要 2 个）`,
    )
  }

  return { ok: failures.length === 0, failures, warnings }
}
