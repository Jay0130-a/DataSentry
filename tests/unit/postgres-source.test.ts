import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateWithJsonSchema } from '@datasentry/core'
import { loadSource } from '@datasentry/backend/sources/loader.ts'
import { seedReportingDb } from '@datasentry/backend/sources/reporting-db/seed.ts'
import { createPostgresTransport } from '@datasentry/backend/sources/transports/postgres.ts'
import type { SourceTransport } from '@datasentry/backend/sources/transports/types.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

/**
 * 真实数据源：Postgres（没配连接串时用 PGlite，同一个引擎的 WASM 构建）。
 *
 * 这里刻意不走 Builder 全量构建——那会把 MCP 子进程和 HTTP 服务都拉起来。
 * 直接测「配置 → 传输 → 查询 → 结果契约」这条链，才是这次要验证的东西。
 */
let temp: TempPaths
let transport: SourceTransport
let config: ReturnType<typeof loadSource>['config']

beforeAll(async () => {
  temp = tempPaths('datasentry-pg-')
  await seedReportingDb({ paths: temp.paths })

  const source = loadSource('reporting-db', temp.paths)
  config = source.config
  transport = createPostgresTransport(source, { paths: temp.paths })
}, 60_000)

afterAll(async () => {
  await transport?.close()
  temp?.cleanup()
})

function toolConfig(name: string) {
  const tool = config.tools.find((item) => item.name === name)
  if (!tool) throw new Error(`缺少工具 ${name}`)
  return tool
}

describe('Postgres 数据源', () => {
  it('能查到事业部主数据', async () => {
    const result = await transport.call('list_business_units', {})
    const rows = (result.data as { rows: { code: string; name: string }[] }).rows

    expect(rows.map((row) => row.code)).toEqual(['BU01', 'BU02', 'BU03', 'BU04'])
    expect(rows[0]!.name).toBe('华东事业部')

    const check = validateWithJsonSchema(toolConfig('list_business_units').resultSchema, result.data)
    expect(check.ok, check.ok ? '' : check.message).toBe(true)
  })

  it('按期间与事业部汇总收入，结果符合结果契约', async () => {
    const result = await transport.call('revenue_by_bu', {
      period: '2025-09',
      buCodes: ['BU01', 'BU02'],
    })
    const rows = (result.data as { rows: { buCode: string; revenue: number }[] }).rows

    expect(rows).toHaveLength(2)
    expect(rows[0]!.buCode).toBe('BU01')
    // numeric 在驱动里可能是字符串；传输层统一 cast 成 float8，契约要求 number
    expect(typeof rows[0]!.revenue).toBe('number')
    expect(rows[0]!.revenue).toBe(8_240_000)

    const check = validateWithJsonSchema(toolConfig('revenue_by_bu').resultSchema, result.data)
    expect(check.ok, check.ok ? '' : check.message).toBe(true)
  })

  it('参数是参数化的：塞 SQL 片段只会当成普通值，查不到东西', async () => {
    const result = await transport.call('revenue_by_bu', {
      period: "2025-09' or '1'='1",
      buCodes: ['BU01'],
    })
    const rows = (result.data as { rows: unknown[] }).rows

    expect(rows).toHaveLength(0)
    expect(result.meta.rowCount).toBe(0)
  })

  it('没有数据的期间返回空数组，而不是报错', async () => {
    const result = await transport.call('cost_by_bu', {
      period: '2024-01',
      buCodes: ['BU01'],
    })

    expect((result.data as { rows: unknown[] }).rows).toHaveLength(0)
  })

  it('未声明的工具直接拒绝', async () => {
    await expect(transport.call('drop_everything', {})).rejects.toMatchObject({
      code: 'TOOL_NOT_REGISTERED',
    })
  })
})
