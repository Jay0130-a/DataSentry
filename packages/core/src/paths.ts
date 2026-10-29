import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 仓库路径解析。
 *
 * 回归样本需要把状态库、事件轨迹、产物都写进独立的临时目录，否则样本之间会互相污染，
 * 「重启恢复」这类用例也没法构造。所以所有路径都从 `DataPaths` 出，不接受硬编码。
 */
export interface DataPaths {
  /** 仓库根目录（含 workspaces 字段的 package.json 所在处） */
  root: string
  /** 运行期数据目录 */
  data: string
  /** SQLite 状态库 */
  db: string
  /** JSONL 事件轨迹目录 */
  events: string
  /** 报表产物目录 */
  artifacts: string
  /** 模拟数仓 SQLite 文件 */
  warehouseDb: string
  /** 模拟手工调整 Excel 文件 */
  excelAdjustments: string
  /** 本地 SMTP 收件器落盘的邮件（stream 模式与 `npm run mail` 用） */
  mail: string
  /** 凭据文件（不入库、不进模型上下文） */
  credentials: string
  /** Source 配置目录 */
  sources: string
  /** Skill 配置目录 */
  skills: string
  /** Workspace 配置目录 */
  workspaces: string
}

function isRepoRoot(dir: string): boolean {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown }
    return parsed.workspaces !== undefined
  } catch {
    return false
  }
}

/** 从 `startDir` 逐级向上找到 monorepo 根目录。 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir)
  for (;;) {
    if (isRepoRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`找不到仓库根目录（从 ${startDir} 向上未发现含 workspaces 的 package.json）`)
    }
    dir = parent
  }
}

export interface DataPathOverrides {
  root?: string
  data?: string
}

/**
 * 解析全部运行期路径。
 *
 * 优先级：显式入参 > 环境变量（`DATASENTRY_ROOT` / `DATASENTRY_DATA_DIR`）> 默认值。
 * 环境变量让回归脚本和测试可以不改代码就切换数据目录。
 */
export function dataPaths(overrides: DataPathOverrides = {}): DataPaths {
  const root = resolve(overrides.root ?? process.env['DATASENTRY_ROOT'] ?? findRepoRoot())
  const data = resolve(
    overrides.data ?? process.env['DATASENTRY_DATA_DIR'] ?? join(root, 'data'),
  )

  return {
    root,
    data,
    db: join(data, 'datasentry.db'),
    events: join(data, 'events'),
    artifacts: join(data, 'artifacts'),
    warehouseDb: join(data, 'warehouse.db'),
    excelAdjustments: join(data, 'manual-adjustments.xlsx'),
    mail: join(data, 'mail'),
    credentials: join(data, 'credentials.json'),
    sources: join(root, 'sources'),
    skills: join(root, 'skills'),
    workspaces: join(root, 'workspaces'),
  }
}
