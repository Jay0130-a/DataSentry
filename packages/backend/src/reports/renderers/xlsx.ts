import ExcelJS from 'exceljs'
import type { ReportArtifact } from '@datasentry/core'
import { reportTitle } from './format.ts'

/**
 * Excel 渲染。
 *
 * 用多张工作表而不是一张大宽表：报表是给人看的，
 * 「核心指标 / 数据来源 / 口径冲突 / 注脚」分开，读者不用横向滚动去找。
 */
export async function renderXlsx(artifact: ReportArtifact, path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'DataSentry'
  workbook.created = new Date(artifact.generatedAt)

  const title = reportTitle(artifact)

  // —— 核心指标 ——
  const metrics = workbook.addWorksheet('核心指标', { views: [{ state: 'frozen', ySplit: 1 }] })
  metrics.columns = [
    { header: '指标', key: 'label', width: 22 },
    { header: '数值', key: 'value', width: 18, style: { numFmt: '#,##0.00' } },
    { header: '单位', key: 'unit', width: 10 },
    { header: '口径', key: 'formula', width: 44 },
    { header: '完整性', key: 'completeness', width: 12 },
  ]
  for (const metric of artifact.metrics) {
    metrics.addRow({
      label: metric.label,
      // 金额与笔数写原始数值（Excel 里还能继续算），比率写小数但显示成百分比
      value: metric.unit === '比率' ? Number((metric.value * 100).toFixed(2)) : metric.value,
      unit: metric.unit === '比率' ? '%' : metric.unit,
      formula: metric.formula,
      completeness: metric.completeness,
    })
  }
  styleHeader(metrics)

  // —— 数据来源 ——
  const sources = workbook.addWorksheet('数据来源', { views: [{ state: 'frozen', ySplit: 1 }] })
  sources.columns = [
    { header: '数据源', key: 'slug', width: 14 },
    { header: '结果编号', key: 'resultId', width: 38 },
    { header: '数据版本', key: 'dataVersion', width: 26 },
    { header: '完整性', key: 'completeness', width: 12 },
  ]
  for (const source of artifact.sources) {
    sources.addRow(source)
  }
  styleHeader(sources)

  // —— 口径冲突（有才建这张表）——
  if (artifact.conflicts.length > 0) {
    const conflicts = workbook.addWorksheet('口径冲突')
    conflicts.columns = [
      { header: '指标', key: 'metricKey', width: 18 },
      { header: '说明', key: 'description', width: 60 },
      { header: '来源', key: 'source', width: 16 },
      { header: '数值', key: 'value', width: 18 },
    ]
    for (const conflict of artifact.conflicts) {
      for (const candidate of conflict.candidates) {
        conflicts.addRow({
          metricKey: conflict.metricKey,
          description: conflict.description,
          source: candidate.sourceSlug,
          value: candidate.value,
        })
      }
    }
    styleHeader(conflicts)
  }

  // —— 注脚 ——
  const notes = workbook.addWorksheet('注脚与告警')
  notes.columns = [
    { header: '项目', key: 'key', width: 20 },
    { header: '内容', key: 'value', width: 80 },
  ]
  notes.addRow({ key: '报表', value: title })
  notes.addRow({ key: '报表编号', value: artifact.reportId })
  notes.addRow({ key: '草稿版本', value: artifact.draftVersion })
  notes.addRow({ key: '指标规则版本', value: artifact.ruleVersion })
  notes.addRow({ key: '生成时间', value: artifact.generatedAt })
  notes.addRow({ key: '币种', value: artifact.currency })
  for (const warning of artifact.warnings) {
    notes.addRow({ key: '告警', value: warning })
  }
  styleHeader(notes)

  await workbook.xlsx.writeFile(path)
}

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEFF2F6' },
  }
  header.alignment = { vertical: 'middle' }
}
