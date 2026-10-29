import { dataPaths } from '@datasentry/core'
import { loadLocalEnv } from '@datasentry/backend/env.ts'
import { seedReportingDb } from '@datasentry/backend/sources/reporting-db/seed.ts'

/**
 * 写入经营报表库的种子数据。
 *
 * - 配了 `DATASENTRY_PG_URL`：写真实 Postgres
 * - 没配：写 `data/pg`（内嵌 PGlite，Postgres 的 WASM 构建）
 */
// 先读 .env：DATASENTRY_PG_URL / DATASENTRY_DATA_DIR 都可能在文件里。
loadLocalEnv()
const paths = dataPaths()
const connectionString = process.env['DATASENTRY_PG_URL']
const result = await seedReportingDb({ paths })

process.stdout.write(
  [
    `已写入 ${result.units} 个事业部、${result.revenueRows} 条收入、${result.costRows} 条成本`,
    connectionString ? `目标：${connectionString}` : `目标：${paths.data}/pg（内嵌 PGlite）`,
    '',
  ].join('\n'),
)
