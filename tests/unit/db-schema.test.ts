import { afterEach, describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { openDatabase, schema, type DatabaseHandle } from '@datasentry/backend/db/index.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let handle: DatabaseHandle

afterEach(() => {
  handle?.close()
  temp?.cleanup()
})

/**
 * DDL 与 Drizzle 定义是两份表述，必须保持一致。
 *
 * 与其引入 drizzle-kit 的生成步骤，不如用一条测试把漂移钉死：
 * 建表后反查实际列，与 Drizzle 表对象逐列比对。
 */
describe('状态库 schema 一致性', () => {
  it('每张表的实际列与 Drizzle 定义完全一致', () => {
    temp = tempPaths()
    handle = openDatabase(temp.paths)

    for (const [name, table] of Object.entries(schema.ALL_TABLES)) {
      const declared = Object.values(getTableColumns(table)).map((column) => column.name)
      const physical = handle.sqlite
        .prepare(`PRAGMA table_info(${getSqlTableName(name)})`)
        .all() as { name: string }[]
      const physicalNames = physical.map((row) => row.name)

      expect(physicalNames.length, `表 ${name} 不存在或没有列`).toBeGreaterThan(0)
      expect(new Set(physicalNames), `表 ${name} 的列不一致`).toEqual(new Set(declared))
    }
  })

  it('主键与索引就位', () => {
    temp = tempPaths()
    handle = openDatabase(temp.paths)

    const indexes = handle.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
      .all() as { name: string }[]

    expect(indexes.map((row) => row.name).sort()).toEqual([
      'idx_approval_session',
      'idx_auth_audit_at',
      'idx_auth_session_user',
      'idx_checkpoint_session_step',
      'idx_event_session_seq',
      'idx_report_session',
      'idx_source_workspace',
      'idx_tool_call_session',
      'idx_workspace_member_user',
    ])
  })

  it('建表是幂等的，重复打开不会报错也不会丢数据', () => {
    temp = tempPaths()
    const first = openDatabase(temp.paths)
    first.sqlite.prepare(
      `INSERT INTO workspace (id, name, sources, skills, default_permission_mode, rule_version, currency, timezone, created_at)
       VALUES ('ws_1', 'w', '[]', '[]', 'ask', 'r1', 'CNY', 'Asia/Shanghai', '2025-09-01T00:00:00.000Z')`,
    ).run()
    first.close()

    handle = openDatabase(temp.paths)
    const rows = handle.sqlite.prepare('SELECT count(*) AS c FROM workspace').all() as { c: number }[]
    expect(rows[0]?.c).toBe(1)
  })
})

function getSqlTableName(schemaKey: string): string {
  const map: Record<string, string> = {
    workspaces: 'workspace',
    sessions: 'session',
    sources: 'source',
    skills: 'skill',
    toolCalls: 'tool_call',
    approvals: 'approval',
    checkpoints: 'checkpoint',
    events: 'event',
    reports: 'report',
    users: 'user',
    authSessions: 'auth_session',
    workspaceMembers: 'workspace_member',
    authAudit: 'auth_audit',
  }
  return map[schemaKey] ?? schemaKey
}
