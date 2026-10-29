import { budgetFacts, dataVersion, expenseLines } from './dataset.ts'
import type { ToolHandlerMap } from './types.ts'

function pickBuCodes(args: Record<string, unknown>): string[] | undefined {
  const raw = args['buCodes']
  if (!Array.isArray(raw)) return undefined
  return raw.map((v) => String(v))
}

export const financeHandlers: ToolHandlerMap = {
  async fetch_budget(args) {
    const period = String(args['period'])
    const rows = budgetFacts(period).map((b) => ({
      buCode: b.buCode,
      buName: b.buName,
      budgetRevenue: b.budgetRevenue,
      budgetExpense: b.budgetExpense,
    }))

    return {
      data: {
        period,
        rows,
        totalBudgetRevenue: rows.reduce((acc, r) => acc + r.budgetRevenue, 0),
      },
      meta: {
        dataVersion: dataVersion('finance', period),
        completeness: 'full' as const,
        rowCount: rows.length,
      },
    }
  },

  /**
   * 费用明细——全系统唯一的机密数据集。
   *
   * 注意 meta 里**只**回行数与合计，不回报销人。事件轨迹落库时用的就是这份 meta，
   * 因此明细内容不会因为「记了个日志」而泄漏到轨迹里。
   */
  async fetch_expense_detail(args) {
    const period = String(args['period'])
    const buCodes = pickBuCodes(args)
    const category = args['category'] === undefined ? undefined : String(args['category'])

    const rows = expenseLines(period)
      .filter((line) => !buCodes || buCodes.includes(line.buCode))
      .filter((line) => !category || line.category === category)
      .map((line) => ({
        expenseId: line.expenseId,
        buCode: line.buCode,
        buName: line.buName,
        category: line.category,
        claimant: line.claimant,
        amount: line.amount,
        voucherNo: line.voucherNo,
        incurredOn: line.incurredOn,
      }))

    const totalExpense = rows.reduce((acc, r) => acc + r.amount, 0)

    return {
      data: { period, rows, totalExpense },
      meta: {
        dataVersion: dataVersion('finance', period),
        completeness: 'full' as const,
        rowCount: rows.length,
        // 敏感数据的摘要只留形状，不留内容。
        sensitivity: 'confidential',
        totalExpense,
      },
    }
  },
}
