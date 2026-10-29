import { describe, expect, it } from 'vitest'
import type { ToolResult } from '@datasentry/core'
import {
  computeMetrics,
  CONFLICT_THRESHOLD,
  DEFAULT_METRIC_INPUTS,
  METRIC_KEYS,
  metricInputsOf,
  REQUIRED_METRICS,
  requiredMetricsOf,
} from '@datasentry/backend/reports/metrics.ts'
import { validateReport } from '@datasentry/backend/reports/validate.ts'

function result(
  toolName: string,
  slug: string,
  data: unknown,
  completeness: ToolResult['completeness'] = 'full',
): ToolResult {
  return {
    resultId: `res_${slug}_${toolName}`,
    toolName,
    sourceRef: { slug, tool: toolName.split('__')[2] ?? toolName, dataVersion: 'v1' },
    completeness,
    data,
    meta: { dataVersion: 'v1', completeness, rowCount: 1 },
  }
}

const revenue = result('mcp__erp__fetch_revenue', 'erp', {
  period: '2025-09',
  rows: [],
  totalRevenue: 1_000_000,
})
const cost = result('mcp__erp__fetch_cost', 'erp', {
  period: '2025-09',
  rows: [],
  totalCost: 600_000,
})
const budget = result('mcp__finance__fetch_budget', 'finance', {
  period: '2025-09',
  rows: [],
  totalBudgetRevenue: 1_100_000,
})
const adjustments = result('mcp__excel__fetch_manual_adjustments', 'excel', {
  period: '2025-09',
  rows: [],
  totalAdjustment: -25_000,
})
const warehouse = (totalRevenue: number): ToolResult =>
  result('mcp__warehouse__query_monthly_aggregate', 'warehouse', {
    period: '2025-09',
    rows: [],
    totalRevenue,
    totalCost: 600_000,
    totalOrders: 1_744,
  })

function metricValue(key: string, all: ReturnType<typeof computeMetrics>): number | undefined {
  return all.metrics.find((m) => m.key === key)?.value
}

describe('指标规则', () => {
  it('按口径派生毛利、毛利率与预算差异率', () => {
    const computed = computeMetrics([revenue, cost, budget, adjustments, warehouse(1_000_000)])

    expect(metricValue(METRIC_KEYS.revenue, computed)).toBe(1_000_000)
    expect(metricValue(METRIC_KEYS.cost, computed)).toBe(600_000)
    expect(metricValue(METRIC_KEYS.grossProfit, computed)).toBe(400_000)
    expect(metricValue(METRIC_KEYS.grossMargin, computed)).toBe(0.4)
    expect(metricValue(METRIC_KEYS.budgetVariance, computed)).toBeCloseTo(-0.090909, 5)
    expect(metricValue(METRIC_KEYS.manualAdjustment, computed)).toBe(-25_000)
    expect(metricValue(METRIC_KEYS.adjustedRevenue, computed)).toBe(975_000)
    expect(metricValue(METRIC_KEYS.orderCount, computed)).toBe(1_744)
  })

  it('手工调整与系统口径收入分列，不合并成一个数', () => {
    const computed = computeMetrics([revenue, cost, budget, adjustments, warehouse(1_000_000)])
    expect(metricValue(METRIC_KEYS.revenue, computed)).toBe(1_000_000)
    expect(metricValue(METRIC_KEYS.adjustedRevenue, computed)).not.toBe(1_000_000)
  })

  it('口径一致时不产生冲突', () => {
    const computed = computeMetrics([revenue, cost, budget, adjustments, warehouse(1_000_000)])
    expect(computed.conflicts).toEqual([])
  })

  it('数仓与 ERP 差异超过阈值时判为口径冲突，并保留双方候选值', () => {
    const drifted = warehouse(Math.round(1_000_000 * (1 + CONFLICT_THRESHOLD + 0.01)))
    const computed = computeMetrics([revenue, cost, budget, adjustments, drifted])

    expect(computed.conflicts).toHaveLength(1)
    expect(computed.conflicts[0]!.metricKey).toBe(METRIC_KEYS.revenue)
    expect(computed.conflicts[0]!.candidates.map((c) => c.sourceSlug).sort()).toEqual([
      'erp',
      'warehouse',
    ])
  })

  it('缺收入时不虚构指标，只留告警', () => {
    const computed = computeMetrics([cost, budget])
    expect(metricValue(METRIC_KEYS.revenue, computed)).toBeUndefined()
    expect(metricValue(METRIC_KEYS.grossProfit, computed)).toBeUndefined()
    expect(computed.warnings.join()).toContain('缺少收入输入')
  })

  it('指标完整性取输入里最差的一档', () => {
    const partial = result('mcp__erp__fetch_revenue', 'erp', { totalRevenue: 1_000_000 }, 'partial')
    const computed = computeMetrics([partial, cost, budget, adjustments, warehouse(1_000_000)])
    expect(computed.metrics.find((m) => m.key === METRIC_KEYS.revenue)?.completeness).toBe('partial')
  })
})

describe('报表校验', () => {
  const full = computeMetrics([revenue, cost, budget, adjustments, warehouse(1_000_000)])

  it('齐备且口径一致时通过，partial 只算告警', () => {
    const outcome = validateReport({
      results: [revenue, cost, budget, adjustments, warehouse(1_000_000)],
      metrics: full.metrics,
      conflicts: full.conflicts,
      warnings: full.warnings,
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.failures).toEqual([])
  })

  it('缺必需指标时判失败', () => {
    const only = computeMetrics([cost, budget])
    const outcome = validateReport({
      results: [cost, budget],
      metrics: only.metrics,
      conflicts: [],
      warnings: only.warnings,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.join()).toContain('缺少必需指标：revenue')
  })

  it('口径冲突判失败（交由调用方转人工，而不是静默取一个数）', () => {
    const drifted = warehouse(1_200_000)
    const computed = computeMetrics([revenue, cost, budget, adjustments, drifted])
    const outcome = validateReport({
      results: [revenue, cost, budget, adjustments, drifted],
      metrics: computed.metrics,
      conflicts: computed.conflicts,
      warnings: computed.warnings,
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.failures.join()).toContain('口径冲突')
  })

  it('只用到一个数据源时不认可交叉核对', () => {
    const only = computeMetrics([revenue, cost])
    const outcome = validateReport({
      results: [revenue, cost],
      metrics: only.metrics,
      conflicts: [],
      warnings: [],
    })
    expect(outcome.failures.join()).toContain('至少需要 2 个')
  })
})

describe('指标输入可配置', () => {
  it('换工具与字段：来自报表库的数据也能算收入', () => {
    const pg = result('mcp__reporting-db__revenue_by_bu', 'reporting-db', {
      rows: [
        { buCode: 'BU01', revenue: 400_000 },
        { buCode: 'BU02', revenue: 600_000 },
      ],
    })

    const computed = computeMetrics([pg], {
      revenue: { tool: 'reporting-db.revenue_by_bu', field: 'rows', sum: 'revenue' },
    })

    expect(metricValue(METRIC_KEYS.revenue, computed)).toBe(1_000_000)
    // 没配成本输入，毛利就不该被虚构出来
    expect(metricValue(METRIC_KEYS.grossProfit, computed)).toBeUndefined()
  })

  it('支持点号路径取值', () => {
    const nested = result('mcp__erp__fetch_revenue', 'erp', { totals: { revenue: 777 } })
    const computed = computeMetrics([nested], {
      revenue: { tool: 'erp.fetch_revenue', field: 'totals.revenue' },
    })
    expect(metricValue(METRIC_KEYS.revenue, computed)).toBe(777)
  })

  it('只配置的输入生效，没配的不会回退到默认', () => {
    // budget 结果在，但没配 budgetRevenue 输入 —— 不该悄悄用默认映射
    const computed = computeMetrics([revenue, cost, budget], {
      revenue: { tool: 'erp.fetch_revenue', field: 'totalRevenue' },
      cost: { tool: 'erp.fetch_cost', field: 'totalCost' },
    })

    expect(metricValue(METRIC_KEYS.revenue, computed)).toBe(1_000_000)
    expect(metricValue(METRIC_KEYS.budgetRevenue, computed)).toBeUndefined()
    expect(computed.warnings.join()).toContain('缺少预算输入')
  })

  it('数组里有一项不是数字时整项作废，不静默跳过', () => {
    const dirty = result('mcp__reporting-db__revenue_by_bu', 'reporting-db', {
      rows: [{ revenue: 10 }, { revenue: 'oops' }],
    })
    const computed = computeMetrics([dirty], {
      revenue: { tool: 'reporting-db.revenue_by_bu', field: 'rows', sum: 'revenue' },
    })

    expect(metricValue(METRIC_KEYS.revenue, computed)).toBeUndefined()
    expect(computed.warnings.join()).toContain('缺少收入输入')
  })

  it('required 来自配置：多要求一项就判不完整', () => {
    const computed = computeMetrics([revenue, cost])
    const outcome = validateReport({
      results: [revenue, cost],
      metrics: computed.metrics,
      conflicts: computed.conflicts,
      warnings: computed.warnings,
      required: [...REQUIRED_METRICS, METRIC_KEYS.budgetRevenue],
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.failures.join()).toContain('budgetRevenue')
  })

  it('required 来自配置：只要求收入时，缺成本也能通过', () => {
    const computed = computeMetrics([revenue, budget], {
      revenue: { tool: 'erp.fetch_revenue', field: 'totalRevenue' },
    })
    const outcome = validateReport({
      results: [revenue, budget],
      metrics: computed.metrics,
      conflicts: computed.conflicts,
      warnings: computed.warnings,
      required: [METRIC_KEYS.revenue],
    })

    expect(outcome.ok).toBe(true)
  })
})

describe('Workspace 指标配置', () => {
  it('没配置时用内置默认', () => {
    expect(metricInputsOf({})).toBe(DEFAULT_METRIC_INPUTS)
    expect(requiredMetricsOf({})).toEqual(REQUIRED_METRICS)
  })

  it('配置了就只用配置的输入，不与默认合并', () => {
    const inputs = { revenue: { tool: 'x.y', field: 'z' } }
    expect(metricInputsOf({ metrics: { inputs } })).toBe(inputs)
  })

  it('required 可以被配置覆盖', () => {
    expect(requiredMetricsOf({ metrics: { required: ['revenue'] } })).toEqual(['revenue'])
  })
})
