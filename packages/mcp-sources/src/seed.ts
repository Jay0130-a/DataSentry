import { existsSync, writeFileSync } from 'node:fs'
import { dataPaths, type DataPaths } from '@datasentry/core'
import { ensureAdjustmentsWorkbook } from './excel.ts'
import { ensureDataDirs } from './paths.ts'
import { seedWarehouseDatabase } from './warehouse-http.ts'

/**
 * 开发凭据。
 *
 * 这些值只在本地模拟环境使用，写进 `data/credentials.json`（已在 .gitignore 中）。
 * 它们**不会**进入模型上下文、事件轨迹或报表产物——只由 CredentialManager
 * 注入到子进程环境变量与 HTTP 头。
 */
const DEV_CREDENTIALS: Record<string, string> = {
  'erp.token': 'dev-erp-token-2f8a1c',
  'finance.token': 'dev-finance-token-91b7de',
}

export interface SeedResult {
  warehouseRows: number
  adjustmentsRows: number
  adjustmentsFile: string
  credentialsFile: string
  credentialsCreated: boolean
}

/**
 * 准备本地模拟环境：数仓 SQLite、手工调整 Excel、开发凭据。
 * 幂等——重复执行不会覆盖已有文件。
 *
 * 接受 `paths` 是为了让回归脚本能把模拟数据建到临时目录里，
 * 各样本之间因此完全隔离。
 */
export async function seedAll(paths: DataPaths = dataPaths()): Promise<SeedResult> {
  ensureDataDirs(paths)

  const warehouseRows = seedWarehouseDatabase(paths)
  const { rows: adjustmentsRows } = await ensureAdjustmentsWorkbook(paths.excelAdjustments)

  let credentialsCreated = false
  if (!existsSync(paths.credentials)) {
    writeFileSync(paths.credentials, `${JSON.stringify(DEV_CREDENTIALS, null, 2)}\n`, 'utf8')
    credentialsCreated = true
  }

  return {
    warehouseRows,
    adjustmentsRows,
    adjustmentsFile: paths.excelAdjustments,
    credentialsFile: paths.credentials,
    credentialsCreated,
  }
}
