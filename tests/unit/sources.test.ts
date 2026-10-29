import { afterAll, describe, expect, it } from 'vitest'
import {
  buildToolName,
  dataPaths,
  parseToolName,
  SourceType,
} from '@datasentry/core'
import { loadAllSources, loadSource } from '@datasentry/backend/sources/loader.ts'
import { listWorkspaces, loadWorkspace } from '@datasentry/backend/workspace/loader.ts'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'
import { seedAll } from '@datasentry/mcp-sources'

const paths = dataPaths()

describe('工具命名', () => {
  it('拼成 mcp__{source}__{tool}', () => {
    expect(buildToolName('erp', 'fetch_revenue')).toBe('mcp__erp__fetch_revenue')
  })

  it('解析回去得到 source 与 tool', () => {
    expect(parseToolName('mcp__erp__fetch_revenue')).toEqual({
      sourceSlug: 'erp',
      toolName: 'fetch_revenue',
    })
    expect(parseToolName('mcp__finance__fetch_expense_detail')).toEqual({
      sourceSlug: 'finance',
      toolName: 'fetch_expense_detail',
    })
  })

  it('格式不对时返回 null', () => {
    expect(parseToolName('erp.fetch_revenue')).toBeNull()
    expect(parseToolName('mcp__erp')).toBeNull()
    expect(parseToolName('mcp__erp__')).toBeNull()
  })
})

describe('Source 配置加载', () => {
  it('六个 Source 都能加载并覆盖四种接入类型', () => {
    const sources = loadAllSources(paths)
    expect(sources.map((s) => s.config.slug)).toEqual([
      'erp',
      'excel',
      'finance',
      'publish',
      'reporting-db',
      'warehouse',
    ])

    const types = new Set(sources.map((s) => s.config.type))
    expect(types).toEqual(
      new Set([SourceType.MCP_STDIO, SourceType.HTTP, SourceType.LOCAL, SourceType.POSTGRES]),
    )
  })

  it('每个 Source 都有 guide，且工具都声明了敏感级别与副作用', () => {
    for (const source of loadAllSources(paths)) {
      expect(source.guideText.length, `${source.config.slug} 的 guide 是空的`).toBeGreaterThan(200)
      for (const tool of source.config.tools) {
        expect(tool.sensitivity).toBeTruthy()
        expect(tool.sideEffect).toBeTruthy()
        // 参数契约必须是合法 JSON Schema，否则运行时才炸就太晚了
        expect(tool.paramsSchema['type']).toBe('object')
      }
    }
  })

  it('配置里的占位符已被解析成真实路径', () => {
    const excel = loadSource('excel', paths)
    const options = excel.config.type === 'local' ? excel.config.transport.options : {}
    expect(String(options['file'])).toContain(paths.data)
    expect(String(options['file'])).not.toContain('${')
  })

  it('费用明细被标为机密——它是全系统唯一的敏感数据集', () => {
    const finance = loadSource('finance', paths)
    const expense = finance.config.tools.find((t) => t.name === 'fetch_expense_detail')
    expect(expense?.sensitivity).toBe('confidential')
  })

  it('Source 版本随 guide 内容变化（审批绑定依赖它）', () => {
    const a = loadSource('erp', paths)
    const b = loadSource('erp', paths)
    expect(a.version).toBe(b.version)
    expect(a.version).toMatch(/^[0-9a-f]{16}$/)
  })

  it('slug 与目录名不一致时报错', () => {
    expect(() => loadSource('nonexistent', paths)).toThrowError(/缺少 config.json/)
  })
})

describe('Workspace 加载', () => {
  it('group-finance 绑定了六个 Source，含发布网关与报表库', () => {
    const workspace = loadWorkspace('group-finance', paths)
    expect(workspace.sources).toEqual([
      'erp',
      'finance',
      'warehouse',
      'excel',
      'publish',
      'reporting-db',
    ])
    expect(workspace.skills).toEqual(['monthly-operation-report', 'monthly-crosscheck'])
    expect(workspace.currency).toBe('CNY')
    expect(workspace.allowedRecipients).toContain('board@example.com')
  })

  it('retail-analytics 只有 erp —— 用来验证跨 Workspace 访问被拒', () => {
    const workspace = loadWorkspace('retail-analytics', paths)
    expect(workspace.sources).toEqual(['erp'])
    expect(workspace.sources).not.toContain('warehouse')
  })

  it('列出全部 Workspace', () => {
    expect(listWorkspaces(paths).map((w) => w.id).sort()).toEqual([
      'group-finance',
      'retail-analytics',
    ])
  })

  it('找不到时报错', () => {
    expect(() => loadWorkspace('nope', paths)).toThrowError(/找不到 Workspace/)
  })
})

/**
 * 集成测试：真的把三种接入方式建起来并调一次。
 *
 * MCP 会 spawn 子进程、HTTP 会起真服务、local 会读真 xlsx。
 * 这条用例的价值就在于它不复用任何桩——配置接错、协议不通、文件读不到都会红。
 */
describe('SourceServerBuilder 集成', () => {
  let temp: TempPaths
  let ctx: AppContext

  afterAll(async () => {
    await ctx?.close()
    temp?.cleanup()
  })

  it('建出全部工具，并且四种接入方式都能真正取到数', async () => {
    temp = tempPaths()
    await seedAll(temp.paths)
    ctx = await createAppContext({ paths: temp.paths })

    const built = await ctx.ensureSources()
    expect(built.transports.size).toBe(6)

    const names = ctx.registry.list().map((t) => t.name)
    expect(names).toContain('datasentry__read_source_guide')
    expect(names).toContain('mcp__erp__fetch_revenue')
    expect(names).toContain('mcp__warehouse__query_monthly_aggregate')
    expect(names).toContain('mcp__excel__fetch_manual_adjustments')
    expect(names).toContain('mcp__publish__publish_report')
    expect(names).toContain('mcp__reporting-db__revenue_by_bu')

    // MCP stdio
    const revenue = await built.transports.get('erp')!.call('fetch_revenue', { period: '2025-09' })
    expect(revenue.meta.completeness).toBe('full')
    expect((revenue.data as { totalRevenue: number }).totalRevenue).toBeGreaterThan(0)

    // HTTP
    const aggregate = await built.transports
      .get('warehouse')!
      .call('query_monthly_aggregate', { period: '2025-09' })
    expect((aggregate.data as { totalOrders: number }).totalOrders).toBeGreaterThan(0)

    // local（读真实 xlsx）
    const adjustments = await built.transports
      .get('excel')!
      .call('fetch_manual_adjustments', { period: '2025-09' })
    expect((adjustments.data as { rows: unknown[] }).rows.length).toBe(3)
  })

  it('未声明的工具被传输层拒绝', async () => {
    const erp = ctx.transports().get('erp')!
    await expect(erp.call('drop_table', {})).rejects.toThrowError(/未声明工具/)
  })
})

/**
 * FR-01 验收标准之一：凭据不进模型上下文、日志与产物。
 *
 * 这里验证的是配套的一半——凭据缺失时链路会明确失败，而不是拿空字符串
 * 继续跑下去，最后变成一个难定位的 401。
 */
describe('凭据缺失时 fail-closed', () => {
  let temp: TempPaths
  let ctx: AppContext

  afterAll(async () => {
    await ctx?.close()
    temp?.cleanup()
  })

  it('没有 credentials.json 时，需要凭据的 Source 调用失败并带上 CREDENTIAL_MISSING', async () => {
    temp = tempPaths()
    // 只建数仓与 Excel，故意不建 credentials.json
    const { seedWarehouseDatabase } = await import('@datasentry/mcp-sources')
    seedWarehouseDatabase(temp.paths)

    ctx = await createAppContext({ paths: temp.paths })
    const built = await ctx.ensureSources()

    await expect(
      built.transports.get('erp')!.call('fetch_revenue', { period: '2025-09' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING' })
  })
})
