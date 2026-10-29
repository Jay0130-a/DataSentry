import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { DataPaths } from '@datasentry/core'

/**
 * 经营报表库的种子数据。
 *
 * 与模拟数仓同源同口径，但落在一个**真实的 Postgres 引擎**里：
 * 配了 `DATASENTRY_PG_URL` 就写真实服务，否则写本地 PGlite 目录。
 */

export const REPORTING_SEED_PERIODS = ['2025-08', '2025-09', '2025-10', '2025-11'] as const

const UNITS = [
  { code: 'BU01', name: '华东事业部' },
  { code: 'BU02', name: '华南事业部' },
  { code: 'BU03', name: '华北事业部' },
  { code: 'BU04', name: '西部事业部' },
] as const

/** 按 2025-09 为基准，其余期间按系数缩放，保证数据可复现。 */
const BASE_REVENUE: Record<string, number> = {
  BU01: 8_240_000,
  BU02: 6_380_000,
  BU03: 5_120_000,
  BU04: 7_736_717,
}

const PERIOD_FACTOR: Record<string, number> = {
  '2025-08': 0.95,
  '2025-09': 1,
  '2025-10': 1.02,
  '2025-11': 0.98,
}

const COST_RATIO: Record<string, number> = {
  BU01: 0.68,
  BU02: 0.71,
  BU03: 0.66,
  BU04: 0.69,
}

const DDL = `
create table if not exists dim_business_unit (
  code text primary key,
  name text not null
);
create table if not exists fact_revenue (
  period  text not null,
  bu_code text not null,
  revenue numeric(18, 2) not null,
  primary key (period, bu_code)
);
create table if not exists fact_cost (
  period  text not null,
  bu_code text not null,
  cost    numeric(18, 2) not null,
  primary key (period, bu_code)
);
`

interface Runner {
  exec(sql: string): Promise<void>
  query(sql: string, params?: unknown[]): Promise<unknown>
  close(): Promise<void>
}

async function openRunner(options: {
  connectionString?: string
  dataDir: string
}): Promise<Runner> {
  if (options.connectionString) {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: options.connectionString })
    return {
      exec: async (sql) => {
        await pool.query(sql)
      },
      query: async (sql, params) => pool.query(sql, params),
      close: () => pool.end(),
    }
  }

  mkdirSync(options.dataDir, { recursive: true })
  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite(options.dataDir)
  await db.waitReady

  return {
    exec: async (sql) => {
      await db.exec(sql)
    },
    query: async (sql, params) => db.query(sql, params ?? []),
    close: () => db.close(),
  }
}

/**
 * 建表并写入种子数据。幂等：重复执行会覆盖同一批主键。
 */
export async function seedReportingDb(input: {
  paths: DataPaths
  /** 覆盖默认的 dataDir（相对数据目录）。 */
  dataDir?: string
  connectionStringEnv?: string
}): Promise<{ units: number; revenueRows: number; costRows: number }> {
  const dataDir = join(input.paths.data, input.dataDir ?? 'pg')
  const connectionString = process.env[input.connectionStringEnv ?? 'DATASENTRY_PG_URL']
  const runner = await openRunner({ ...(connectionString ? { connectionString } : {}), dataDir })

  try {
    await runner.exec(DDL)

    for (const unit of UNITS) {
      await runner.query(
        `insert into dim_business_unit (code, name) values ($1, $2)
         on conflict (code) do update set name = excluded.name`,
        [unit.code, unit.name],
      )
    }

    let revenueRows = 0
    let costRows = 0
    for (const period of REPORTING_SEED_PERIODS) {
      const factor = PERIOD_FACTOR[period] ?? 1
      for (const unit of UNITS) {
        const revenue = Math.round((BASE_REVENUE[unit.code] ?? 0) * factor)
        const cost = Math.round(revenue * (COST_RATIO[unit.code] ?? 0.7))

        await runner.query(
          `insert into fact_revenue (period, bu_code, revenue) values ($1, $2, $3)
           on conflict (period, bu_code) do update set revenue = excluded.revenue`,
          [period, unit.code, revenue],
        )
        await runner.query(
          `insert into fact_cost (period, bu_code, cost) values ($1, $2, $3)
           on conflict (period, bu_code) do update set cost = excluded.cost`,
          [period, unit.code, cost],
        )
        revenueRows += 1
        costRows += 1
      }
    }

    return { units: UNITS.length, revenueRows, costRows }
  } finally {
    await runner.close()
  }
}
