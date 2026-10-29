import {
  ADJUSTMENT_SHEET,
  adjustmentsFileVersion,
  readAdjustmentRows,
} from '@datasentry/mcp-sources'
import type { LocalToolHandlerMap } from '../transports/local.ts'

/**
 * `excel-manual-adjustments` 的进程内实现。
 *
 * 读的是真实 xlsx 文件（exceljs 解析），不是内存表；`fileVersion` 取行内容摘要，
 * 这样「内容没变但文件被另存过」不会被误判成数据版本变化。
 */
export const excelManualAdjustmentsHandlers: LocalToolHandlerMap = {
  async fetch_manual_adjustments(args, ctx) {
    const file = String(ctx.options['file'] ?? '')
    const sheet = String(ctx.options['sheet'] ?? ADJUSTMENT_SHEET)
    if (!file) {
      throw new Error('excel-manual-adjustments 缺少 options.file')
    }

    const period = String(args['period'])
    const all = await readAdjustmentRows(file, sheet)
    const rows = all
      .filter((row) => row.period === period)
      .map((row) => ({
        buCode: row.buCode,
        buName: row.buName,
        amount: row.amount,
        reason: row.reason,
        preparedBy: row.preparedBy,
      }))

    const fileVersion = await adjustmentsFileVersion(file, sheet)

    return {
      data: {
        period,
        fileVersion,
        rows,
        totalAdjustment: rows.reduce((acc, row) => acc + row.amount, 0),
      },
      meta: {
        dataVersion: fileVersion,
        completeness: 'full' as const,
        rowCount: rows.length,
      },
    }
  },
}
