import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataPaths, type DataPaths } from '@datasentry/core'

export interface TempPaths {
  paths: DataPaths
  cleanup: () => void
}

/**
 * 一份隔离的数据目录。
 *
 * `root` 保持指向真实仓库（sources / skills / workspaces 是配置，本就该共享），
 * 只有运行期数据（状态库、事件轨迹、产物、模拟数据）落到临时目录。
 * 这样样本之间不会互相污染，也能反复构造「重启」这类场景。
 */
export function tempPaths(prefix = 'datasentry-test-'): TempPaths {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    paths: dataPaths({ data: dir }),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 上文件偶尔还被句柄占着，清理失败不该让测试变红
      }
    },
  }
}
