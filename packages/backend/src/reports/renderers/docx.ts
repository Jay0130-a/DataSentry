import { writeFileSync } from 'node:fs'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import type { ReportArtifact } from '@datasentry/core'
import { formatMetric, reportMetaLines, reportTitle } from './format.ts'

/** Word 渲染。中文靠字体名交给 Word 自己解析，不嵌字体。 */
export async function renderDocx(artifact: ReportArtifact, path: string): Promise<void> {
  const children: Array<Paragraph | Table> = []

  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: reportTitle(artifact), bold: true })],
    }),
  )

  for (const [key, value] of reportMetaLines(artifact)) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${key}：`, bold: true }),
          new TextRun({ text: value }),
        ],
      }),
    )
  }

  children.push(new Paragraph({ text: '' }))

  children.push(sectionTitle('核心指标'))
  children.push(
    buildTable(
      ['指标', '数值', '口径', '完整性'],
      artifact.metrics.map((metric) => [
        metric.label,
        formatMetric(metric),
        metric.formula,
        metric.completeness,
      ]),
      [22, 16, 46, 16],
    ),
  )

  children.push(sectionTitle('数据来源'))
  children.push(
    buildTable(
      ['数据源', '结果编号', '数据版本', '完整性'],
      artifact.sources.map((source) => [
        source.slug,
        source.resultId,
        source.dataVersion,
        source.completeness,
      ]),
      [14, 40, 30, 16],
    ),
  )

  if (artifact.conflicts.length > 0) {
    children.push(sectionTitle('口径冲突（需人工判定）'))
    for (const conflict of artifact.conflicts) {
      children.push(new Paragraph({ text: `${conflict.metricKey}：${conflict.description}` }))
      for (const candidate of conflict.candidates) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            text: `${candidate.sourceSlug}：${candidate.value}（${candidate.resultId}）`,
          }),
        )
      }
    }
  }

  if (artifact.warnings.length > 0) {
    children.push(sectionTitle('注脚与告警'))
    for (const warning of artifact.warnings) {
      children.push(new Paragraph({ bullet: { level: 0 }, text: warning }))
    }
  }

  children.push(
    new Paragraph({
      text: '本报表由 DataSentry 生成。发布前需人工二次确认。',
      alignment: AlignmentType.CENTER,
      spacing: { before: 400 },
    }),
  )

  const doc = new Document({
    creator: 'DataSentry',
    title: reportTitle(artifact),
    styles: {
      default: {
        document: {
          run: { font: 'Microsoft YaHei', size: 21 },
        },
      },
    },
    sections: [{ children }],
  })

  writeFileSync(path, await Packer.toBuffer(doc))
}

function sectionTitle(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 120 },
    children: [new TextRun({ text, bold: true })],
  })
}

/** 百分比列宽，四个数字加和为 100。 */
function buildTable(headers: string[], rows: string[][], widths: number[]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (header, index) =>
        new TableCell({
          width: { size: widths[index] ?? 25, type: WidthType.PERCENTAGE },
          children: [
            new Paragraph({ children: [new TextRun({ text: header, bold: true })] }),
          ],
          shading: { fill: 'EFF2F6' },
        }),
    ),
  })

  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell, index) =>
            new TableCell({
              width: { size: widths[index] ?? 25, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ text: cell })],
            }),
        ),
      }),
  )

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  })
}
