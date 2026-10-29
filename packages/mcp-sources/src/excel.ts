import { existsSync } from 'node:fs'
import ExcelJS from 'exceljs'
import { hashValue } from '@datasentry/core'
import { manualAdjustments, periodRange, type ManualAdjustment } from './dataset.ts'

export const ADJUSTMENT_SHEET = '调整项'

const COLUMNS = [
  { header: '期间', key: 'period', width: 12 },
  { header: '事业部编码', key: 'buCode', width: 14 },
  { header: '事业部', key: 'buName', width: 22 },
  { header: '调整金额(元)', key: 'amount', width: 16 },
  { header: '调整事由', key: 'reason', width: 24 },
  { header: '编制人', key: 'preparedBy', width: 16 },
] as const

/**
 * 写出手工调整 Excel。
 *
 * 注意 `fileVersion` 取的是**行内容**的摘要而不是文件字节摘要：
 * Excel 每次保存都会写入新的时间戳，按字节算会导致「内容没变但版本变了」，
 * 那样报表里声明的数据版本就失去意义。
 */
export async function writeAdjustmentsWorkbook(
  file: string,
  periods: string[] = periodRange('2024-01', '2025-12'),
): Promise<{ fileVersion: string; rows: number }> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'DataSentry'
  const sheet = workbook.addWorksheet(ADJUSTMENT_SHEET)
  sheet.columns = COLUMNS as unknown as ExcelJS.Column[]

  const all: ManualAdjustment[] = []
  for (const period of periods) {
    all.push(...manualAdjustments(period))
  }
  for (const row of all) {
    sheet.addRow(row)
  }

  await workbook.xlsx.writeFile(file)
  return { fileVersion: adjustmentsVersion(all), rows: all.length }
}

/** 已存在就不再重建，避免覆盖人工编辑过的调整表。 */
export async function ensureAdjustmentsWorkbook(
  file: string,
  periods?: string[],
): Promise<{ fileVersion: string; created: boolean; rows: number }> {
  if (existsSync(file)) {
    const rows = await readAdjustmentRows(file)
    return { fileVersion: adjustmentsVersion(rows), created: false, rows: rows.length }
  }
  const { fileVersion, rows } = await writeAdjustmentsWorkbook(file, periods)
  return { fileVersion, created: true, rows }
}

function adjustmentsVersion(rows: ManualAdjustment[]): string {
  return `xlsx:${hashValue(rows).slice(0, 12)}`
}

/** 读取整表。缺 sheet / 缺列时给出明确错误，而不是返回空数组蒙混过去。 */
export async function readAdjustmentRows(
  file: string,
  sheetName: string = ADJUSTMENT_SHEET,
): Promise<ManualAdjustment[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  const sheet = workbook.getWorksheet(sheetName)
  if (!sheet) {
    throw new Error(`Excel 文件 ${file} 中找不到工作表 "${sheetName}"`)
  }

  const header = sheet.getRow(1)
  const index = new Map<string, number>()
  header.eachCell((cell, col) => {
    index.set(String(cell.value ?? '').trim(), col)
  })

  const required = ['期间', '事业部编码', '事业部', '调整金额(元)', '调整事由', '编制人']
  const missing = required.filter((name) => !index.has(name))
  if (missing.length > 0) {
    throw new Error(`Excel 表头缺少列：${missing.join('、')}`)
  }

  const rows: ManualAdjustment[] = []
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r)
    const period = String(row.getCell(index.get('期间')!).value ?? '').trim()
    if (!period) continue

    rows.push({
      period,
      buCode: String(row.getCell(index.get('事业部编码')!).value ?? '').trim(),
      buName: String(row.getCell(index.get('事业部')!).value ?? '').trim(),
      amount: Number(row.getCell(index.get('调整金额(元)')!).value ?? 0),
      reason: String(row.getCell(index.get('调整事由')!).value ?? '').trim(),
      preparedBy: String(row.getCell(index.get('编制人')!).value ?? '').trim(),
    })
  }
  return rows
}

/** 文件级版本号，用于取数结果里的 `fileVersion`。 */
export async function adjustmentsFileVersion(
  file: string,
  sheetName: string = ADJUSTMENT_SHEET,
): Promise<string> {
  return adjustmentsVersion(await readAdjustmentRows(file, sheetName))
}
