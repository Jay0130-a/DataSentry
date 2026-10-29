import { createHash } from 'node:crypto'

/**
 * 模拟数据集的确定性生成。
 *
 * 全部数值由 `period` 字符串派生，不依赖当前时间、随机数种子或文件顺序——
 * 同一 period 在任何机器、任何次运行都得到同一组数字。
 * 这是 M4「固定样本 + 事件轨迹回归」能判定 PASS/FAIL 的前提：
 * 如果数据本身会漂，回归就只剩噪音。
 */

/** 生成 `YYYY-MM` 序列（含两端），用于种子数据覆盖的期间范围。 */
export function periodRange(from: string, to: string): string[] {
  const [fy, fm] = from.split('-').map(Number) as [number, number]
  const [ty, tm] = to.split('-').map(Number) as [number, number]
  const out: string[] = []
  let y = fy
  let m = fm
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return out
}

export interface BusinessUnit {
  code: string
  name: string
  region: string
  /** 基准月收入（元），用于派生各期数据。 */
  baseRevenue: number
  /** 基准成本率。 */
  costRatio: number
}

export const BUSINESS_UNITS: readonly BusinessUnit[] = [
  { code: 'BU-EAST', name: '华东制造事业部', region: '华东', baseRevenue: 12_400_000, costRatio: 0.68 },
  { code: 'BU-SOUTH', name: '华南零售事业部', region: '华南', baseRevenue: 8_650_000, costRatio: 0.745 },
  { code: 'BU-NORTH', name: '华北服务事业部', region: '华北', baseRevenue: 6_180_000, costRatio: 0.61 },
]

/** 由字符串派生的稳定 32 位种子。 */
function seedOf(...parts: string[]): number {
  const digest = createHash('sha256').update(parts.join('|'), 'utf8').digest()
  return digest.readUInt32BE(0)
}

/** mulberry32：小、快、可复现的 PRNG。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 在 ±ratio 范围内取一个确定性扰动系数。 */
function jitter(rand: () => number, ratio: number): number {
  return 1 + (rand() * 2 - 1) * ratio
}

export interface RevenueFact {
  period: string
  buCode: string
  buName: string
  region: string
  /** 主营业务收入（元） */
  revenue: number
  /** 主营业务成本（元） */
  cost: number
}

/**
 * ERP 侧的收入/成本明细。
 *
 * 同一 period 恒定；`erp` 与 `warehouse` 两个 Source 共用它，
 * 因此默认情况下两条口径天然一致。M4 的「口径冲突」样本会在数仓侧注入漂移。
 */
export function revenueFacts(period: string): RevenueFact[] {
  return BUSINESS_UNITS.map((bu) => {
    const rand = mulberry32(seedOf('revenue', period, bu.code))
    const revenue = Math.round(bu.baseRevenue * jitter(rand, 0.12))
    const cost = Math.round(revenue * bu.costRatio * jitter(rand, 0.05))
    return {
      period,
      buCode: bu.code,
      buName: bu.name,
      region: bu.region,
      revenue,
      cost,
    }
  })
}

export interface BudgetFact {
  period: string
  buCode: string
  buName: string
  /** 预算收入（元） */
  budgetRevenue: number
  /** 预算费用（元） */
  budgetExpense: number
}

/** 财务侧预算。按事业部基准收入加 3% 增长假设派生。 */
export function budgetFacts(period: string): BudgetFact[] {
  return BUSINESS_UNITS.map((bu) => {
    const rand = mulberry32(seedOf('budget', period, bu.code))
    const growth = jitter(rand, 0.03)
    const budgetRevenue = Math.round(bu.baseRevenue * 1.03 * growth)
    const budgetExpense = Math.round(budgetRevenue * (1 - bu.costRatio) * 0.82)
    return { period, buCode: bu.code, buName: bu.name, budgetRevenue, budgetExpense }
  })
}

export const EXPENSE_CATEGORIES = [
  '差旅费',
  '市场推广费',
  '咨询服务费',
  '办公与租赁',
  '研发材料费',
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export interface ExpenseLine {
  expenseId: string
  period: string
  buCode: string
  buName: string
  category: ExpenseCategory
  /** 报销人。费用明细属敏感数据——M2 起读取需审批。 */
  claimant: string
  amount: number
  /** 审批单号 */
  voucherNo: string
  incurredOn: string
}

const CLAIMANTS = [
  '张岚',
  '王振宇',
  '李思远',
  '陈可',
  '周慧',
  '赵一鸣',
  '孙雨桐',
  '吴迪',
] as const

/**
 * 财务侧费用明细（逐笔）。
 *
 * 这是全系统唯一的**敏感**数据集：能定位到人、到单笔金额。
 * M2 起读取它必须走审批，M1 只保证它可被调用且带敏感标记。
 */
export function expenseLines(period: string): ExpenseLine[] {
  const lines: ExpenseLine[] = []
  const [year, month] = period.split('-')

  for (const bu of BUSINESS_UNITS) {
    const rand = mulberry32(seedOf('expense', period, bu.code))
    const budget = budgetFacts(period).find((b) => b.buCode === bu.code)
    const target = budget?.budgetExpense ?? 1_000_000

    for (let i = 0; i < EXPENSE_CATEGORIES.length; i += 1) {
      const category = EXPENSE_CATEGORIES[i] as ExpenseCategory
      // 每个类别拆成 2-4 笔，合计逼近该类别的预算份额。
      const share = (0.12 + rand() * 0.2) / EXPENSE_CATEGORIES.length
      const categoryTotal = target * share * jitter(rand, 0.1)
      const count = 2 + Math.floor(rand() * 3)
      for (let n = 0; n < count; n += 1) {
        const claimant = CLAIMANTS[Math.floor(rand() * CLAIMANTS.length)] ?? CLAIMANTS[0]
        const day = 1 + Math.floor(rand() * 27)
        lines.push({
          expenseId: `${period}-${bu.code}-${i}${n}`.toUpperCase(),
          period,
          buCode: bu.code,
          buName: bu.name,
          category,
          claimant,
          amount: Math.round(categoryTotal / count),
          voucherNo: `VCH-${year}${month}-${bu.code.slice(3)}-${i}${n}`,
          incurredOn: `${period}-${String(day).padStart(2, '0')}`,
        })
      }
    }
  }

  return lines.sort((a, b) => a.expenseId.localeCompare(b.expenseId))
}

export interface ManualAdjustment {
  period: string
  buCode: string
  buName: string
  /** 手工调整金额（元），可为负。 */
  amount: number
  reason: string
  preparedBy: string
}

const ADJUSTMENT_REASONS = [
  '跨期收入调整',
  '上期冲销更正',
  '口径重分类',
] as const

/** Excel 侧的手工调整项：落在电子表格里、不走系统的那部分。 */
export function manualAdjustments(period: string): ManualAdjustment[] {
  return BUSINESS_UNITS.map((bu, idx) => {
    const rand = mulberry32(seedOf('adjustment', period, bu.code))
    const facts = revenueFacts(period).find((f) => f.buCode === bu.code)
    const base = facts?.revenue ?? bu.baseRevenue
    // 调整幅度控制在 ±2% 以内，保持合理，同时非零以便报表体现。
    const amount = Math.round(base * (rand() * 0.04 - 0.02))
    return {
      period,
      buCode: bu.code,
      buName: bu.name,
      amount,
      reason: ADJUSTMENT_REASONS[idx % ADJUSTMENT_REASONS.length] as string,
      preparedBy: '财务共享中心',
    }
  })
}

/**
 * 数据版本号。写进每个取数结果的 `dataVersion`，
 * 报表据此声明「本报表基于哪一版数据」，也是口径冲突判定的输入之一。
 */
export function dataVersion(source: string, period: string): string {
  return `${source}:${period}:v1`
}

/** 数仓侧聚合结果。默认与 ERP 一致；`drift` 用于 M4 构造口径冲突样本。 */
export interface WarehouseAggregate {
  period: string
  buCode: string
  buName: string
  revenue: number
  cost: number
  orderCount: number
}

export function warehouseAggregates(period: string, driftRatio = 0): WarehouseAggregate[] {
  return revenueFacts(period).map((fact) => {
    const rand = mulberry32(seedOf('warehouse', period, fact.buCode))
    const factor = 1 + driftRatio
    return {
      period,
      buCode: fact.buCode,
      buName: fact.buName,
      revenue: Math.round(fact.revenue * factor),
      cost: Math.round(fact.cost * factor),
      orderCount: 240 + Math.floor(rand() * 460),
    }
  })
}
