import { mkdirSync } from 'node:fs'
import { dataPaths, type DataPaths } from '@datasentry/core'

/** 确保运行期目录存在。幂等。 */
export function ensureDataDirs(paths: DataPaths = dataPaths()): DataPaths {
  for (const dir of [paths.data, paths.events, paths.artifacts]) {
    mkdirSync(dir, { recursive: true })
  }
  return paths
}
