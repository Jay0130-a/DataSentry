import Database from 'better-sqlite3'
import Fastify, { type FastifyInstance } from 'fastify'
import { dataPaths, type DataPaths } from '@datasentry/core'
import { BUSINESS_UNITS, dataVersion, periodRange, warehouseAggregates } from './dataset.ts'
import { ensureDataDirs } from './paths.ts'
import type { ToolExecution } from './types.ts'

export interface ManagedService {
  url: string
  close: () => Promise<void>
}

export interface WarehouseRow {
  buCode: string
  buName: string
  revenue: number
  cost: number
  orderCount: number
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dim_bu (
  bu_code TEXT PRIMARY KEY,
  bu_name TEXT NOT NULL,
  region  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fact_monthly (
  period      TEXT    NOT NULL,
  bu_code     TEXT    NOT NULL,
  revenue     INTEGER NOT NULL,
  cost        INTEGER NOT NULL,
  order_count INTEGER NOT NULL,
  PRIMARY KEY (period, bu_code)
);
`

/** 生成 `YYYY-MM` 序列，供种子数据覆盖一个可用的期间范围。 */
export { periodRange }

/** 建表并写入全部期间的聚合事实。幂等，可重复执行。 */
export function seedWarehouseDatabase(paths: DataPaths = dataPaths()): number {
  ensureDataDirs(paths)
  const db = new Database(paths.warehouseDb)
  try {
    db.exec(SCHEMA_SQL)

    const insertBu = db.prepare(
      'INSERT OR REPLACE INTO dim_bu (bu_code, bu_name, region) VALUES (?, ?, ?)',
    )
    const insertFact = db.prepare(
      `INSERT OR REPLACE INTO fact_monthly (period, bu_code, revenue, cost, order_count)
       VALUES (?, ?, ?, ?, ?)`,
    )

    const periods = periodRange('2024-01', '2025-12')
    let rows = 0

    const tx = db.transaction(() => {
      for (const unit of BUSINESS_UNITS) {
        insertBu.run(unit.code, unit.name, unit.region)
      }
      for (const period of periods) {
        for (const agg of warehouseAggregates(period)) {
          insertFact.run(period, agg.buCode, agg.revenue, agg.cost, agg.orderCount)
          rows += 1
        }
      }
    })
    tx()

    return rows
  } finally {
    db.close()
  }
}

function queryAggregates(
  paths: DataPaths,
  period: string,
  driftRatio: number,
): WarehouseRow[] {
  const db = new Database(paths.warehouseDb, { readonly: true })
  try {
    const stmt = db.prepare(
      `SELECT f.bu_code AS buCode, d.bu_name AS buName,
              f.revenue AS revenue, f.cost AS cost, f.order_count AS orderCount
         FROM fact_monthly f
         JOIN dim_bu d ON d.bu_code = f.bu_code
        WHERE f.period = ?
        ORDER BY f.bu_code`,
    )
    const rows = stmt.all(period) as WarehouseRow[]
    if (driftRatio === 0) return rows
    const factor = 1 + driftRatio
    return rows.map((row) => ({
      ...row,
      revenue: Math.round(row.revenue * factor),
      cost: Math.round(row.cost * factor),
    }))
  } finally {
    db.close()
  }
}

/**
 * 模拟数仓的 HTTP 服务。
 *
 * 这是 FR-01 里 `http` 类型 Source 的真实形态：后端通过 HTTP 调用它，
 * 参数与结果都要过 Schema。由后端作为 managed 服务拉起（见 `managed` 配置），
 * 换成真实数仓时只需把配置改成 `baseUrl` 指向外部地址。
 */
export async function startWarehouseHttp(
  options: { port?: number; paths?: DataPaths } = {},
): Promise<ManagedService> {
  const paths = options.paths ?? dataPaths()
  const app: FastifyInstance = Fastify({ logger: false })

  app.get('/health', async () => ({ status: 'ok', source: 'warehouse' }))

  app.post('/tools/:tool', async (request, reply) => {
    const { tool } = request.params as { tool: string }
    const body = (request.body ?? {}) as { params?: Record<string, unknown> }

    if (tool !== 'query_monthly_aggregate') {
      return reply.code(404).send({
        error: { code: 'TOOL_NOT_REGISTERED', message: `数仓未提供工具 "${tool}"` },
      })
    }

    const params = body.params ?? {}
    const period = String(params['period'])
    const driftRatio = Number(params['driftRatio'] ?? 0)

    let rows: WarehouseRow[]
    try {
      rows = queryAggregates(paths, period, driftRatio)
    } catch (err) {
      return reply.code(500).send({
        error: {
          code: 'TOOL_EXECUTION_FAILED',
          message: `数仓查询失败：${err instanceof Error ? err.message : String(err)}`,
        },
      })
    }

    const execution: ToolExecution = {
      data: {
        period,
        rows,
        totalRevenue: rows.reduce((acc, r) => acc + r.revenue, 0),
        totalCost: rows.reduce((acc, r) => acc + r.cost, 0),
        totalOrders: rows.reduce((acc, r) => acc + r.orderCount, 0),
      },
      meta: {
        dataVersion: dataVersion('warehouse', period),
        completeness: driftRatio !== 0 ? 'partial' : 'full',
        rowCount: rows.length,
        driftRatio,
      },
    }

    return reply.send(execution)
  })

  await app.listen({ host: '127.0.0.1', port: options.port ?? 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') {
    await app.close()
    throw new Error('数仓服务启动后拿不到监听地址')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close()
    },
  }
}
