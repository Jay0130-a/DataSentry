import { join } from 'node:path'
import { hashValue, type DataPaths, type ToolExecution } from '@datasentry/core'
import type { LoadedSource } from '../loader.ts'
import { ToolExecutionError, type SourceTransport } from './types.ts'

/**
 * Postgres 接入。
 *
 * 与官方 MCP 的 Postgres server 不同，这里**不允许模型写 SQL**：
 * 每个工具在 `config.json` 里固定一条参数化查询，模型只能填参数。
 * 理由很直接——「让模型自由写 SQL」意味着权限链只能校验「这是不是合法查询」，
 * 而校验不了「它该不该读这张表、会不会扫全库」。
 *
 * 两种后端：
 * - 配了 `DATASENTRY_PG_URL`：连真实 Postgres 服务（生产形态）；
 * - 没配：用 PGlite（Postgres 编译成 WASM）落一个本地目录，开箱即用。
 *   SQL 引擎是同一个，差别只在有没有 TCP 连接。
 */

export interface PgClient {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  close(): Promise<void>
}

export interface PgClientOptions {
  connectionStringEnv: string
  /** PGlite 的数据目录（绝对路径）。 */
  dataDir: string
  timeoutMs: number
}

export type PgClientFactory = (options: PgClientOptions) => Promise<PgClient>

async function defaultFactory(options: PgClientOptions): Promise<PgClient> {
  const connectionString = process.env[options.connectionStringEnv]

  if (connectionString) {
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString, connectionTimeoutMillis: options.timeoutMs })
    return {
      query: async (sql, params) => {
        const result = await pool.query(sql, params)
        return { rows: result.rows as Record<string, unknown>[] }
      },
      close: () => pool.end(),
    }
  }

  const { PGlite } = await import('@electric-sql/pglite')
  const db = new PGlite(options.dataDir)
  await db.waitReady
  return {
    query: async (sql, params) => {
      const result = await db.query(sql, params)
      return { rows: result.rows as Record<string, unknown>[] }
    },
    close: () => db.close(),
  }
}

export interface PostgresTransportDeps {
  paths: DataPaths
  /** 测试注入用；默认按连接串 / PGlite 选择。 */
  createClient?: PgClientFactory
}

export function createPostgresTransport(
  source: LoadedSource,
  deps: PostgresTransportDeps,
): SourceTransport {
  const config = source.config
  if (config.type !== 'postgres') {
    throw new Error(`Source ${config.slug} 不是 postgres 类型`)
  }

  const options: PgClientOptions = {
    connectionStringEnv: config.transport.connectionStringEnv,
    dataDir: join(deps.paths.data, config.transport.dataDir),
    timeoutMs: config.transport.timeoutMs,
  }

  const factory = deps.createClient ?? defaultFactory
  let clientPromise: Promise<PgClient> | null = null

  const client = async (): Promise<PgClient> => {
    clientPromise ??= factory(options)
    return clientPromise
  }

  return {
    slug: config.slug,

    async call(toolName, args): Promise<ToolExecution> {
      const tool = config.tools.find((item) => item.name === toolName)
      if (!tool) {
        throw new ToolExecutionError('TOOL_NOT_REGISTERED', `Source ${config.slug} 没有工具 ${toolName}`)
      }
      if (!tool.sql) {
        throw new ToolExecutionError(
          'SOURCE_CONFIG_INVALID',
          `工具 ${toolName} 没有配置 sql——postgres 类型必须写死查询`,
        )
      }

      // 参数顺序来自配置，值来自模型；SQL 本身永远不来自模型。
      const values = (tool.params ?? []).map((name) => args[name] ?? null)

      const connection = await client()
      let rows: Record<string, unknown>[]
      try {
        const result = await withTimeout(
          connection.query(tool.sql, values),
          options.timeoutMs,
          toolName,
        )
        rows = result.rows
      } catch (err) {
        throw new ToolExecutionError(
          'TOOL_EXECUTION_FAILED',
          `${config.slug}.${toolName} 查询失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }

      return {
        data: { rows },
        meta: {
          dataVersion: `pg:${config.slug}:${hashValue(rows).slice(0, 12)}`,
          completeness: 'full',
          rowCount: rows.length,
        },
      }
    },

    async close(): Promise<void> {
      if (!clientPromise) return
      const connection = await clientPromise.catch(() => null)
      await connection?.close()
      clientPromise = null
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`查询超时（${timeoutMs}ms）：${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
