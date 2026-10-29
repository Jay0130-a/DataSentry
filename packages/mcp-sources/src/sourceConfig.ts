import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataPaths, sourceConfigSchema, type DataPaths, type SourceConfig } from '@datasentry/core'

/**
 * 读取 `sources/<slug>/config.json` 与 `guide.md`。
 *
 * 模拟服务端与后端读的是**同一份** config，因此不存在「服务暴露的工具」与
 * 「后端认为的工具」漂移的可能——工具契约只有一个事实来源。
 */
export function sourceDir(slug: string, paths: DataPaths = dataPaths()): string {
  return join(paths.sources, slug)
}

export function loadSourceConfig(slug: string, paths: DataPaths = dataPaths()): SourceConfig {
  const file = join(sourceDir(slug, paths), 'config.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`读不到 Source 配置：${file}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }

  const result = sourceConfigSchema.safeParse(parsed)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `${file} 不符合 Source 配置契约：${first ? `${first.path.join('.')} ${first.message}` : '未知错误'}`,
    )
  }
  return result.data
}

/** guide.md 原文。内容摘要会作为工具版本的一部分参与审批绑定。 */
export function loadGuideText(slug: string, paths: DataPaths = dataPaths()): string {
  const config = loadSourceConfig(slug, paths)
  const file = join(sourceDir(slug, paths), config.guide)
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new Error(`读不到 Source guide：${file}`)
  }
}

/** 枚举 `sources/` 下的全部 slug。 */
export function listSourceSlugs(paths: DataPaths = dataPaths()): string[] {
  if (!existsSync(paths.sources)) return []
  return readdirSync(paths.sources, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}
