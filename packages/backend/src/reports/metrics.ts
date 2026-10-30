import {
  buildToolName,
  Completeness,
  type Conflict,
  type MetricValue,
  type ToolResult,
} from '@datasentry/core'

/**
 * 指标规则引擎（PRD FR-02 / §5「指标规则计算」）。
 *
 * 分两层：
 * - **输入映射**（哪个工具、取哪个字段）→ Workspace 配置
 * - **公式**（毛利 = 收入 − 成本）→ 代码，受测试保护
 *
 * 这样换数据源只改配置，不会动公式；而公式改错会被回归抓住，
 * 因为它是业务口径，不该变成一份随手可改的配置。
 */

export const METRIC_KEYS = {
  revenue: 'revenue',
  cost: 'cost',
  grossProfit: 'grossProfit',
  grossMargin: 'grossMargin',
  budgetRevenue: 'budgetRevenue',
  budgetVariance: 'budgetVariance',
  manualAdjustment: 'manualAdjustment',
  adjustedRevenue: 'adjustedRevenue',
  orderCount: 'orderCount',
  warehouseRevenueDelta: 'warehouseRevenueDelta',
} as const

export type MetricKey = (typeof METRIC_KEYS)[keyof typeof METRIC_KEYS]

/** 数仓与 ERP 收入差异超过该比例即判定为口径冲突（见 sources/warehouse/guide.md）。 */
export const CONFLICT_THRESHOLD = 0.005

/** 指标计算需要哪些输入。每个输入对应「一个工具 + 一个字段」。 */
export const METRIC_INPUT_KEYS = [
  'revenue',
  'cost',
  'budgetRevenue',
  'warehouseRevenue',
  'orderCount',
  'adjustment',
] as const

export type MetricInputKey = (typeof METRIC_INPUT_KEYS)[number]

export interface MetricInputRule {
  /** 工具引用：`<sourceSlug>.<toolName>`，例如 `erp.fetch_revenue`。 */
  tool: string
  /** 结果 `data` 里的数值字段，支持点号路径。 */
  field: string
  /** 字段是数组时，按这个子字段求和（SQL 类工具常见的形状）。 */
  sum?: string
}

export type MetricInputs = Partial<Record<MetricInputKey, MetricInputRule>>

/**
 * 内置默认映射，等价于改造前写死的口径。
 *
 * Workspace 一旦配置了 `metrics.inputs`，就**只用配置里的输入**——
 * 不做「没配就用默认」的逐项回退，否则少写一行会静默算出另一套数。
 */
export const DEFAULT_METRIC_INPUTS: MetricInputs = {
  revenue: { tool: 'erp.fetch_revenue', field: 'totalRevenue' },
  cost: { tool: 'erp.fetch_cost', field: 'totalCost' },
  budgetRevenue: { tool: 'finance.fetch_budget', field: 'totalBudgetRevenue' },
  warehouseRevenue: { tool: 'warehouse.query_monthly_aggregate', field: 'totalRevenue' },
  orderCount: { tool: 'warehouse.query_monthly_aggregate', field: 'totalOrders' },
  adjustment: { tool: 'excel.fetch_manual_adjustments', field: 'totalAdjustment' },
}

/** 经营月报必须具备的指标——缺任何一个都不能宣称报表完整。 */
export const REQUIRED_METRICS: readonly string[] = [
  METRIC_KEYS.revenue,
  METRIC_KEYS.cost,
  METRIC_KEYS.grossProfit,
]

/** Workspace 里与指标有关的那一小块配置。 */
export interface WorkspaceMetricConfig {
  metrics?: {
    inputs?: MetricInputs
    required?: readonly string[]
  }
}

/** Workspace 配置的输入映射；没配置就用内置默认。 */
export function metricInputsOf(workspace: WorkspaceMetricConfig): MetricInputs {
  return workspace.metrics?.inputs ?? DEFAULT_METRIC_INPUTS
}

/** Workspace 要求的必需指标；没配置就用内置三项。 */
export function requiredMetricsOf(workspace: WorkspaceMetricConfig): readonly string[] {
  return workspace.metrics?.required ?? REQUIRED_METRICS
}

export interface MetricsResult {
  metrics: MetricValue[]
  conflicts: Conflict[]
  warnings: string[]
  /** 指标输入本身有歧义等硬错误；调用方应把它们当作校验失败，而不是告警。 */
  errors: string[]
}

interface ResolvedInput {
  result: ToolResult
  value: number
}

function readPath(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function sumByField(raw: unknown, field: string): number | undefined {
  if (!Array.isArray(raw)) return undefined
  let total = 0
  for (const item of raw) {
    const value = readPath(item, field)
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    total += value
  }
  return total
}

function resolveInput(
  results: readonly ToolResult[],
  rule: MetricInputRule | undefined,
  errors: string[],
): ResolvedInput | undefined {
  if (!rule) return undefined

  const [slug, tool] = rule.tool.split('.')
  if (!slug || !tool) return undefined

  const expected = buildToolName(slug, tool)
  const matches = results.filter((item) => item.toolName === expected)
  if (matches.length > 1) {
    // 同一工具被调用多次（不同期间/事业部）时，指标输入无法确定该用哪一条；
    // 静默取第一条会让报表看起来正常，实际却可能用了另一个期间的数据。
    errors.push(
      `指标输入 ${rule.tool} 匹配到 ${matches.length} 条结果，无法确定使用哪一条`,
    )
    return undefined
  }
  const result = matches[0]
  if (!result) return undefined

  const raw = readPath(result.data, rule.field)
  const value = rule.sum
    ? sumByField(raw, rule.sum)
    : typeof raw === 'number' && Number.isFinite(raw)
      ? raw
      : undefined

  return value === undefined ? undefined : { result, value }
}

/** 取多个输入里最差的一档完整性——只要有一环不齐，结论就不能宣称完整。 */
function worstCompleteness(values: readonly Completeness[]): Completeness {
  if (values.includes(Completeness.UNKNOWN)) return Completeness.UNKNOWN
  if (values.includes(Completeness.PARTIAL)) return Completeness.PARTIAL
  return Completeness.FULL
}

interface Draft {
  key: MetricKey
  label: string
  value: number
  unit: string
  formula: string
  inputs: readonly ToolResult[]
}

export function computeMetrics(
  results: readonly ToolResult[],
  inputs: MetricInputs = DEFAULT_METRIC_INPUTS,
): MetricsResult {
  const warnings: string[] = []
  const errors: string[] = []
  const revenue = resolveInput(results, inputs.revenue, errors)
  const cost = resolveInput(results, inputs.cost, errors)
  const budget = resolveInput(results, inputs.budgetRevenue, errors)
  const warehouseRevenue = resolveInput(results, inputs.warehouseRevenue, errors)
  const orderCount = resolveInput(results, inputs.orderCount, errors)
  const adjustment = resolveInput(results, inputs.adjustment, errors)

  const drafts: Draft[] = []

  if (revenue) {
    drafts.push({
      key: METRIC_KEYS.revenue,
      label: '主营业务收入',
      value: revenue.value,
      unit: '元',
      formula: `${inputs.revenue!.tool} 的各事业部收入合计`,
      inputs: [revenue.result],
    })
  } else {
    warnings.push('缺少收入输入（检查 metrics.inputs.revenue），无法计算收入与后续派生指标')
  }

  if (cost) {
    drafts.push({
      key: METRIC_KEYS.cost,
      label: '主营业务成本',
      value: cost.value,
      unit: '元',
      formula: `${inputs.cost!.tool} 的各事业部成本合计`,
      inputs: [cost.result],
    })
  } else {
    warnings.push('缺少成本输入（检查 metrics.inputs.cost），无法计算毛利')
  }

  if (revenue && cost) {
    drafts.push({
      key: METRIC_KEYS.grossProfit,
      label: '毛利',
      value: revenue.value - cost.value,
      unit: '元',
      formula: '主营业务收入 − 主营业务成本',
      inputs: [revenue.result, cost.result],
    })
    drafts.push({
      key: METRIC_KEYS.grossMargin,
      label: '毛利率',
      value: revenue.value === 0 ? 0 : (revenue.value - cost.value) / revenue.value,
      unit: '比率',
      formula: '(主营业务收入 − 主营业务成本) ÷ 主营业务收入',
      inputs: [revenue.result, cost.result],
    })
  }

  if (budget) {
    drafts.push({
      key: METRIC_KEYS.budgetRevenue,
      label: '预算收入',
      value: budget.value,
      unit: '元',
      formula: `${inputs.budgetRevenue!.tool} 的各事业部收入预算合计`,
      inputs: [budget.result],
    })

    if (revenue && budget.value !== 0) {
      drafts.push({
        key: METRIC_KEYS.budgetVariance,
        label: '预算差异率',
        value: (revenue.value - budget.value) / budget.value,
        unit: '比率',
        formula: '(实际收入 − 预算收入) ÷ 预算收入',
        inputs: [revenue.result, budget.result],
      })
    }
  } else {
    warnings.push('缺少预算输入（检查 metrics.inputs.budgetRevenue），无法计算预算差异率')
  }

  if (adjustment) {
    drafts.push({
      key: METRIC_KEYS.manualAdjustment,
      label: '手工调整合计',
      value: adjustment.value,
      unit: '元',
      formula: `${inputs.adjustment!.tool} 当期调整金额合计（可为负）`,
      inputs: [adjustment.result],
    })

    if (revenue) {
      drafts.push({
        key: METRIC_KEYS.adjustedRevenue,
        label: '调整后收入',
        value: revenue.value + adjustment.value,
        unit: '元',
        formula: '主营业务收入 + 手工调整合计',
        inputs: [revenue.result, adjustment.result],
      })
    }
  } else {
    warnings.push('缺少手工调整输入（检查 metrics.inputs.adjustment），调整后收入未计算')
  }

  if (orderCount) {
    drafts.push({
      key: METRIC_KEYS.orderCount,
      label: '订单量',
      value: orderCount.value,
      unit: '笔',
      formula: `${inputs.orderCount!.tool} 的订单数合计`,
      inputs: [orderCount.result],
    })
  }

  // —— 口径核对：两个来源的同一指标必须对得上 ——
  const conflicts: Conflict[] = []
  if (warehouseRevenue && revenue && revenue.value !== 0) {
    const delta = (warehouseRevenue.value - revenue.value) / revenue.value
    const warehouseSlug = warehouseRevenue.result.sourceRef.slug
    const revenueSlug = revenue.result.sourceRef.slug

    drafts.push({
      key: METRIC_KEYS.warehouseRevenueDelta,
      label: '数仓与 ERP 收入差异率',
      value: delta,
      unit: '比率',
      formula: `(${inputs.warehouseRevenue!.tool} 汇总收入 − ${inputs.revenue!.tool} 收入) ÷ ${inputs.revenue!.tool} 收入`,
      inputs: [warehouseRevenue.result, revenue.result],
    })

    if (Math.abs(delta) > CONFLICT_THRESHOLD) {
      conflicts.push({
        metricKey: METRIC_KEYS.revenue,
        description: `${warehouseSlug} 与 ${revenueSlug} 的收入差异 ${(delta * 100).toFixed(2)}%，超过 ${(CONFLICT_THRESHOLD * 100).toFixed(1)}% 阈值，需人工判定采用哪一口径`,
        candidates: [
          {
            sourceSlug: warehouseSlug,
            resultId: warehouseRevenue.result.resultId,
            value: warehouseRevenue.value,
          },
          { sourceSlug: revenueSlug, resultId: revenue.result.resultId, value: revenue.value },
        ],
      })
    }
  }

  const metrics: MetricValue[] = drafts.map((draft) => ({
    key: draft.key,
    label: draft.label,
    value: roundForDisplay(draft.value, draft.unit),
    unit: draft.unit,
    formula: draft.formula,
    inputs: draft.inputs.map((r) => r.resultId),
    completeness: worstCompleteness(draft.inputs.map((r) => r.completeness)),
  }))

  return { metrics, conflicts, warnings, errors }
}

/** 比率保留 6 位小数，金额取整到分。避免浮点尾巴进报表。 */
function roundForDisplay(value: number, unit: string): number {
  if (unit === '比率') return Math.round(value * 1e6) / 1e6
  return Math.round(value * 100) / 100
}
