import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dataPaths, type DataPaths } from '@datasentry/core'

const loaded = new Set<string>()

/**
 * 加载仓库根的 `.env`（如果存在）。
 *
 * 为什么要它：密钥不该写进 `datasentry.config.json`（那会被提交），
 * 但在 Windows 上让用户每次开新终端都 `set` 一遍环境变量也不现实。
 * `.env` 是这两者之间最常规的折中——文件本地、已在 .gitignore 里。
 *
 * **已存在的环境变量优先**：`process.loadEnvFile` 不会覆盖 shell 里显式传的值，
 * 所以 CI / 容器仍然可以用环境变量压过文件，不必改代码。
 */
export function loadLocalEnv(paths: DataPaths = dataPaths()): string | null {
  const file = join(paths.root, '.env')
  if (!existsSync(file)) return null
  if (loaded.has(file)) return file

  process.loadEnvFile(file)
  loaded.add(file)
  return file
}

/** 测试用：让下一个 context 重新读取 .env。 */
export function resetLocalEnvCache(): void {
  loaded.clear()
}
