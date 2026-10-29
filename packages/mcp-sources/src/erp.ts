import { BUSINESS_UNITS, dataVersion, revenueFacts } from './dataset.ts'
import type { ToolHandlerMap } from './types.ts'

function pickBuCodes(args: Record<string, unknown>): string[] | undefined {
  const raw = args['buCodes']
  if (!Array.isArray(raw)) return undefined
  return raw.map((v) => String(v))
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0)
}

/**
 * 模拟 ERP 的工具实现。
 *
 * `completeness` 的语义在这里定义清楚：只要请求的事业部范围小于全量，
 * 结果就是 `partial`——因为「少查了两个事业部」和「数据齐了」在报表上是两回事，
 * 不能都当成完整口径。
 */
export const erpHandlers: ToolHandlerMap = {
  async list_business_units() {
    const rows = BUSINESS_UNITS.map(({ code, name, region }) => ({ code, name, region }))
    return {
      data: { businessUnits: rows },
      meta: {
        dataVersion: 'erp:masterdata:v1',
        completeness: 'full' as const,
        rowCount: rows.length,
      },
    }
  },

  async fetch_revenue(args) {
    const period = String(args['period'])
    const buCodes = pickBuCodes(args)
    const facts = revenueFacts(period).filter((f) => !buCodes || buCodes.includes(f.buCode))
    const rows = facts.map((f) => ({
      buCode: f.buCode,
      buName: f.buName,
      revenue: f.revenue,
    }))

    return {
      data: { period, rows, totalRevenue: sum(rows.map((r) => r.revenue)) },
      meta: {
        dataVersion: dataVersion('erp', period),
        completeness: buCodes && buCodes.length < BUSINESS_UNITS.length ? 'partial' : 'full',
        rowCount: rows.length,
      },
    }
  },

  async fetch_cost(args) {
    const period = String(args['period'])
    const buCodes = pickBuCodes(args)
    const facts = revenueFacts(period).filter((f) => !buCodes || buCodes.includes(f.buCode))
    const rows = facts.map((f) => ({
      buCode: f.buCode,
      buName: f.buName,
      cost: f.cost,
    }))

    return {
      data: { period, rows, totalCost: sum(rows.map((r) => r.cost)) },
      meta: {
        dataVersion: dataVersion('erp', period),
        completeness: buCodes && buCodes.length < BUSINESS_UNITS.length ? 'partial' : 'full',
        rowCount: rows.length,
      },
    }
  },
}
