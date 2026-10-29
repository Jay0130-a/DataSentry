import type { DataPaths } from '@datasentry/core'

/**
 * 配置里的路径占位符。
 *
 * 让 `sources/<slug>/config.json` 能在不同机器、不同数据目录下原样使用，
 * 而不用把绝对路径写进版本库。
 */
const REPO_ROOT = '${REPO_ROOT}'
const DATA_DIR = '${DATA_DIR}'

export function resolvePlaceholders(value: string, paths: DataPaths): string {
  return value.replaceAll(REPO_ROOT, paths.root).replaceAll(DATA_DIR, paths.data)
}

/** 递归解析对象/数组里的占位符。 */
export function resolveDeep<T>(value: T, paths: DataPaths): T {
  if (typeof value === 'string') return resolvePlaceholders(value, paths) as unknown as T
  if (Array.isArray(value)) return value.map((item) => resolveDeep(item, paths)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, paths)
    }
    return out as unknown as T
  }
  return value
}
