import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DataPaths, Report, ReportArtifact } from '@datasentry/core'
import { artifactDir, renderMarkdown } from '../draft.ts'
import { MIME_TYPES, PublishFormat, type PublishFormat as PublishFormatType } from '../publishing.ts'
import { renderDocx } from './docx.ts'
import { renderPdf } from './pdf.ts'
import { renderXlsx } from './xlsx.ts'

export interface RenderedArtifact {
  format: PublishFormatType
  fileName: string
  path: string
  sizeBytes: number
  /** 内容摘要，写进回执——「发出去的到底是哪一份」必须可核对。 */
  sha256: string
  mimeType: string
}

/**
 * 把草稿渲染成可发布的文件。
 *
 * 输入**必须是草稿 JSON**（`draft-v1.json`）而不是数据库里的 Report 行：
 * 那份 JSON 才是当时真正用于校验与人工核对的东西，渲染读它，
 * 才能保证「发出去的文件」与「审过的内容」是同一份。
 */
export async function renderReportArtifact(options: {
  report: Report
  format: PublishFormatType
  paths: DataPaths
}): Promise<RenderedArtifact> {
  const { report, format, paths } = options

  if (!report.artifactPath) {
    throw new Error(`报表 ${report.id} 没有草稿产物路径，无法渲染`)
  }

  const artifact = JSON.parse(readFileSync(report.artifactPath, 'utf8')) as ReportArtifact
  const dir = join(artifactDir(report.sessionId, paths), 'publish')
  mkdirSync(dir, { recursive: true })

  const fileName = `report-${artifact.period}-${report.draftVersion}.${format}`
  const path = join(dir, fileName)

  switch (format) {
    case PublishFormat.EXCEL:
      await renderXlsx(artifact, path)
      break
    case PublishFormat.WORD:
      await renderDocx(artifact, path)
      break
    case PublishFormat.PDF:
      await renderPdf(artifact, path)
      break
    case PublishFormat.MARKDOWN:
      writeFileSync(path, renderMarkdown(artifact), 'utf8')
      break
  }

  const bytes = readFileSync(path)
  return {
    format,
    fileName,
    path,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: MIME_TYPES[format],
  }
}

export * from './format.ts'
// 格式定义住在 publishing.ts（它是审批绑定的一部分），这里转出去方便调用方只 import 一处。
export {
  PublishFormat,
  PUBLISH_FORMATS,
  MIME_TYPES,
  isPublishFormat,
} from '../publishing.ts'
