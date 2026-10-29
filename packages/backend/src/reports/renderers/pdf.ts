import { createWriteStream, existsSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import type { ReportArtifact } from '@datasentry/core'
import { formatMetric, reportMetaLines, reportTitle } from './format.ts'

/**
 * PDF 渲染。
 *
 * 唯一的坑是中文：PDFKit 内置字体不含 CJK，必须外挂一个字体文件。
 * Windows / Linux / macOS 的可用路径差别很大，所以按候选列表探测；
 * 找不到就**明确报错**并告诉用户怎么指定，而不是生成一份全是方块的文件。
 */
const FONT_CANDIDATES: Array<{ path: string; family?: string }> = [
  { path: 'C:/Windows/Fonts/simhei.ttf' },
  { path: 'C:/Windows/Fonts/msyh.ttc', family: 'Microsoft YaHei' },
  { path: 'C:/Windows/Fonts/Deng.ttf' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans CJK SC' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', family: 'WenQuanYi Zen Hei' },
  { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
]

export function resolveCjkFont(): { path: string; family?: string } {
  const override = process.env['DATASENTRY_PDF_FONT']
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`DATASENTRY_PDF_FONT 指向的字体不存在：${override}`)
    }
    return { path: override }
  }

  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate.path)) return candidate
  }

  throw new Error(
    '找不到可用的中文字体，无法生成 PDF。请设置 DATASENTRY_PDF_FONT 指向一个 .ttf/.otf 文件' +
      `（已尝试：${FONT_CANDIDATES.map((c) => c.path).join('、')}）`,
  )
}

interface Column {
  label: string
  /** 占总宽度的比例，四列就写 0.22 / 0.16 / 0.46 / 0.16 这样。 */
  width: number
  align?: 'left' | 'right'
}

export async function renderPdf(artifact: ReportArtifact, path: string): Promise<void> {
  const font = resolveCjkFont()

  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: {
      Title: reportTitle(artifact),
      Author: 'DataSentry',
      Subject: `报表 ${artifact.reportId} / 草稿 ${artifact.draftVersion}`,
    },
  })

  const stream = createWriteStream(path)
  doc.pipe(stream)

  if (font.family) doc.registerFont('cjk', font.path, font.family)
  else doc.registerFont('cjk', font.path)
  doc.font('cjk').fillColor('#111111')

  doc.fontSize(20).text(reportTitle(artifact))
  doc.moveDown(0.4)
  doc.fontSize(9).fillColor('#555555')
  for (const [key, value] of reportMetaLines(artifact)) {
    doc.text(`${key}：${value}`)
  }
  doc.fillColor('#111111')

  doc.moveDown(1)
  doc.fontSize(13).text('核心指标')
  doc.moveDown(0.4)
  drawTable(
    doc,
    [
      { label: '指标', width: 0.22 },
      { label: '数值', width: 0.16, align: 'right' },
      { label: '口径', width: 0.46 },
      { label: '完整性', width: 0.16 },
    ],
    artifact.metrics.map((metric) => [
      metric.label,
      formatMetric(metric),
      metric.formula,
      metric.completeness,
    ]),
  )

  doc.moveDown(1)
  doc.fontSize(13).text('数据来源')
  doc.moveDown(0.4)
  drawTable(
    doc,
    [
      { label: '数据源', width: 0.14 },
      { label: '结果编号', width: 0.4 },
      { label: '数据版本', width: 0.3 },
      { label: '完整性', width: 0.16 },
    ],
    artifact.sources.map((source) => [
      source.slug,
      source.resultId,
      source.dataVersion,
      source.completeness,
    ]),
  )

  if (artifact.conflicts.length > 0) {
    doc.moveDown(1)
    doc.fontSize(13).fillColor('#B3261E').text('口径冲突（需人工判定）')
    doc.fillColor('#111111').fontSize(9)
    for (const conflict of artifact.conflicts) {
      doc.text(`${conflict.metricKey}：${conflict.description}`)
      for (const candidate of conflict.candidates) {
        doc.text(`  · ${candidate.sourceSlug}：${candidate.value}（${candidate.resultId}）`)
      }
    }
  }

  if (artifact.warnings.length > 0) {
    doc.moveDown(1)
    doc.fontSize(13).text('注脚与告警')
    doc.fillColor('#111111').fontSize(9)
    for (const warning of artifact.warnings) {
      doc.text(`· ${warning}`)
    }
  }

  doc.moveDown(1.5)
  doc.fontSize(8).fillColor('#777777').text('本报表由 DataSentry 生成。发布前需人工二次确认。', {
    align: 'center',
  })

  doc.end()
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve())
    stream.on('error', reject)
  })
}

/**
 * 极简表格：逐行量高、画底色、写文字、补分隔线，跨页时自动换页。
 *
 * 没有引表格库——只为了三张固定列宽的表，引一个依赖不划算。
 */
function drawTable(
  doc: PDFKit.PDFDocument,
  columns: readonly Column[],
  rows: readonly string[][],
): void {
  const left = doc.page.margins.left
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const widths = columns.map((column) => column.width * usable)
  const padding = 4

  drawRow(doc, columns, widths, columns.map((c) => c.label), padding, true)
  for (const row of rows) {
    drawRow(doc, columns, widths, row, padding, false)
  }

  function drawRow(
    doc: PDFKit.PDFDocument,
    cols: readonly Column[],
    colWidths: readonly number[],
    cells: readonly string[],
    pad: number,
    header: boolean,
  ): void {
    doc.fontSize(9)

    const heights = cells.map((cell, index) =>
      doc.heightOfString(cell ?? '', {
        width: (colWidths[index] ?? 0) - pad * 2,
        align: cols[index]?.align ?? 'left',
      }),
    )
    const rowHeight = Math.max(...heights, 12) + pad * 2

    const bottom =
      doc.page.height - doc.page.margins.bottom
    if (doc.y + rowHeight > bottom) {
      doc.addPage()
      doc.font('cjk').fontSize(9).fillColor('#111111')
      // 换页后重画表头，否则续页的列会没有含义
      if (!header) drawHeaderAgain()
    }

    const top = doc.y
    if (header) {
      doc.save().rect(left, top, usableWidth(), rowHeight).fill('#EFF2F6').restore()
      doc.fillColor('#111111')
    }

    let x = left
    for (let index = 0; index < cells.length; index += 1) {
      doc.fillColor(header ? '#1C2024' : '#111111')
      doc.text(cells[index] ?? '', x + pad, top + pad, {
        width: (colWidths[index] ?? 0) - pad * 2,
        align: cols[index]?.align ?? 'left',
      })
      x += colWidths[index] ?? 0
    }

    doc
      .moveTo(left, top + rowHeight)
      .lineTo(left + usableWidth(), top + rowHeight)
      .lineWidth(0.5)
      .strokeColor('#D5D9DE')
      .stroke()

    doc.y = top + rowHeight
  }

  function drawHeaderAgain(): void {
    drawRow(doc, columns, widths, columns.map((c) => c.label), padding, true)
  }

  function usableWidth(): number {
    return widths.reduce((sum, width) => sum + width, 0)
  }
}
