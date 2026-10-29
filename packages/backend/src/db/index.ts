import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { dataPaths, type DataPaths } from '@datasentry/core'
import { DDL_STATEMENTS } from './ddl.ts'
import * as schema from './schema.ts'

export type Db = BetterSQLite3Database<typeof schema>

export interface DatabaseHandle {
  db: Db
  /** 原始句柄，供 PRAGMA / 事务等 Drizzle 未覆盖的场景使用。 */
  sqlite: Database.Database
  close: () => void
}

/**
 * 唯一的 SQLite 驱动接入点。
 *
 * 选 better-sqlite3 是因为它是同步的，状态机与检查点的写入因此不需要
 * 在调用方散布 async/await——「保存检查点」这种动作越简单越不容易出错。
 * 如果将来要换成 `node:sqlite`，只需要改这一个文件。
 */
export function createDatabase(paths: DataPaths = dataPaths()): DatabaseHandle {
  mkdirSync(dirname(paths.db), { recursive: true })
  const sqlite = new Database(paths.db)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return { db: drizzle(sqlite, { schema }), sqlite, close: () => sqlite.close() }
}

/**
 * 增量列。
 *
 * `CREATE TABLE IF NOT EXISTS` 不会给**已存在**的表补列，而 `data/` 是会被保留的。
 * 所以新增列除了写进 DDL，还要在这里登记一次，老库才能在启动时补齐。
 */
const ADDITIVE_COLUMNS: readonly { table: string; column: string; ddl: string }[] = [
  { table: 'session', column: 'created_by', ddl: 'created_by TEXT' },
  { table: 'user', column: 'approver_roles', ddl: "approver_roles TEXT NOT NULL DEFAULT '[]'" },
]

function applyAdditiveColumns(sqlite: Database.Database): void {
  for (const item of ADDITIVE_COLUMNS) {
    const columns = sqlite
      .prepare(`PRAGMA table_info(${item.table})`)
      .all() as { name: string }[]
    if (columns.some((column) => column.name === item.column)) continue
    sqlite.exec(`ALTER TABLE ${item.table} ADD COLUMN ${item.ddl}`)
  }
}

/** 建表。幂等，启动时无条件执行。 */
export function migrate(handle: DatabaseHandle): void {
  const tx = handle.sqlite.transaction(() => {
    for (const statement of DDL_STATEMENTS) {
      handle.sqlite.exec(statement)
    }
    applyAdditiveColumns(handle.sqlite)
  })
  tx()
}

/** 打开数据库并确保表结构就绪。 */
export function openDatabase(paths: DataPaths = dataPaths()): DatabaseHandle {
  const handle = createDatabase(paths)
  migrate(handle)
  return handle
}

export { schema }
