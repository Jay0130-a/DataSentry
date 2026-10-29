import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReportArtifact } from '@datasentry/core'
import {
  renderReportArtifact,
  PUBLISH_FORMATS,
  type PublishFormat,
} from '@datasentry/backend/reports/renderers/index.ts'
import { resolveCjkFont } from '@datasentry/backend/reports/renderers/pdf.ts'
import { dataPaths } from '@datasentry/core'

/** 一份完整草稿，覆盖指标、来源、口径冲突与注脚四种内容。 */
function artifact(): ReportArtifact {
  return {
    reportId: 'rpt_test_001',
    sessionId: 'sess_test_001',
    draftVersion: 'v1-abcdef123456',
    ruleVersion: 'rules-2025.09',
    period: '2025-09',
    currency: 'CNY',
    generatedAt: '2025-10-01T00:00:00.000Z',
    metrics: [
      {
        key: 'revenue',
        label: '主营业务收入',
        value: 27_475_717,
        unit: '元',
        formula: 'ERP fetch_revenue 的各事业部收入合计',
        inputs: ['res_1'],
        completeness: 'full',
      },
      {
        key: 'grossMargin',
        label: '毛利率',
        value: 0.3165,
        unit: '比率',
        formula: '(收入 − 成本) ÷ 收入',
        inputs: ['res_1', 'res_2'],
        completeness: 'full',
      },
      {
        key: 'orderCount',
        label: '订单量',
        value: 1744,
        unit: '笔',
        formula: '数仓订单数合计',
        inputs: ['res_3'],
        completeness: 'partial',
      },
    ],
    conflicts: [
      {
        metricKey: 'revenue',
        description: '数仓与 ERP 差异超阈值',
        candidates: [
          { sourceSlug: 'erp', resultId: 'res_1', value: 27_475_717 },
          { sourceSlug: 'warehouse', resultId: 'res_3', value: 27_800_000 },
        ],
      },
    ],
    sources: [
      {
        slug: 'erp',
        resultId: 'res_1',
        dataVersion: 'erp:2025-09:v1',
        completeness: 'full',
      },
    ],
    warnings: ['指标「订单量」完整性为 partial，发布后需在正文中标注'],
  }
}

/** 用一份临时 Report 记录喂给渲染器。 */
function reportFor(dir: string): Parameters<typeof renderReportArtifact>[0]['report'] {
  const jsonPath = join(dir, 'draft-v1.json')
  writeFileSync(jsonPath, JSON.stringify(artifact()), 'utf8')

  return {
    id: 'rpt_test_001',
    sessionId: 'sess_test_001',
    workspaceId: 'group-finance',
    draftVersion: 'v1-abcdef123456',
    status: 'draft',
    ruleVersion: 'rules-2025.09',
    metrics: [],
    conflicts: [],
    resultRefs: [],
    dataVersions: {},
    recipientsHash: null,
    receiptId: null,
    artifactPath: jsonPath,
    meta: {},
    createdAt: '2025-10-01T00:00:00.000Z',
    updatedAt: '2025-10-01T00:00:00.000Z',
  }
}

let tempDir: string | null = null

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

/** PDF 需要中文字体；没有就跳过，而不是让整个套件红掉。 */
function pdfAvailable(): boolean {
  try {
    resolveCjkFont()
    return true
  } catch {
    return false
  }
}

describe('发布文件渲染', () => {
  it('四种格式都能生成非空文件，且文件头对得上', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'datasentry-render-'))
    const paths = dataPaths({ data: tempDir })
    const report = reportFor(tempDir)

    const rendered = new Map<PublishFormat, string>()

    for (const format of PUBLISH_FORMATS) {
      if (format === 'pdf' && !pdfAvailable()) continue

      const result = await renderReportArtifact({ report, format, paths })
      const bytes = readFileSync(result.path)
      const size = statSync(result.path).size

      expect(size, `${format} 文件不应为 0 字节`).toBeGreaterThan(200)
      expect(result.sizeBytes).toBe(size)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.fileName).toBe(`report-2025-09-v1-abcdef123456.${format}`)

      if (format === 'xlsx' || format === 'docx') {
        // OOXML 都是 zip
        expect(bytes.subarray(0, 2).toString('utf8')).toBe('PK')
      }
      if (format === 'pdf') {
        expect(bytes.subarray(0, 4).toString('utf8')).toBe('%PDF')
      }
      rendered.set(format, result.sha256)
    }

    // 同一份数据、不同格式 → 字节不同（摘要不应相同）
    const hashes = [...rendered.values()]
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('Markdown 里能读出中文标题与指标', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'datasentry-render-'))
    const paths = dataPaths({ data: tempDir })
    const report = reportFor(tempDir)

    const result = await renderReportArtifact({ report, format: 'md', paths })
    const text = readFileSync(result.path, 'utf8')

    expect(text).toContain('经营月报 · 2025-09')
    expect(text).toContain('主营业务收入')
    expect(text).toContain('31.65%')
    expect(text).toContain('口径冲突')
  })

  it('Excel 是可用工作簿，能读回指标表', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'datasentry-render-'))
    const paths = dataPaths({ data: tempDir })
    const report = reportFor(tempDir)

    const result = await renderReportArtifact({ report, format: 'xlsx', paths })

    // 用同一个库读回来，证明不是「随便写了个 zip」
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(result.path)

    const metrics = workbook.getWorksheet('核心指标')
    expect(metrics).toBeDefined()
    expect(metrics!.getRow(1).getCell(1).value).toBe('指标')
    expect(metrics!.getRow(2).getCell(1).value).toBe('主营业务收入')

    expect(workbook.getWorksheet('数据来源')).toBeDefined()
    expect(workbook.getWorksheet('口径冲突')).toBeDefined()
    expect(workbook.getWorksheet('注脚与告警')).toBeDefined()
  })

  it('PDF 内嵌了中文字体（文件明显大于纯文本）', async () => {
    if (!pdfAvailable()) return
    tempDir = mkdtempSync(join(tmpdir(), 'datasentry-render-'))
    const paths = dataPaths({ data: tempDir })
    const report = reportFor(tempDir)

    const result = await renderReportArtifact({ report, format: 'pdf', paths })
    // 只嵌字体子集也要几 KB；纯英文 PDF 通常 < 2KB
    expect(result.sizeBytes).toBeGreaterThan(4000)
  })
})
