import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dataPaths,
  hashValue,
  sourceConfigSchema,
  type DataPaths,
  type SourceConfig,
} from '@datasentry/core'
import { resolveDeep } from './placeholders.ts'

/** 一个已经从磁盘加载并校验过的 Source。 */
export interface LoadedSource {
  config: SourceConfig
  guideText: string
  /** config + guide 的内容摘要，作为工具版本参与审批绑定。 */
  version: string
  dir: string
  configPath: string
  guidePath: string
}

export function sourceDir(slug: string, paths: DataPaths): string {
  return join(paths.sources, slug)
}

export function loadSource(slug: string, paths: DataPaths = dataPaths()): LoadedSource {
  const dir = sourceDir(slug, paths)
  const configPath = join(dir, 'config.json')

  if (!existsSync(configPath)) {
    throw new Error(`Source "${slug}" 缺少 config.json：${configPath}`)
  }

  let parsedConfig: unknown
  try {
    parsedConfig = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    throw new Error(
      `${configPath} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const result = sourceConfigSchema.safeParse(parsedConfig)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `${configPath} 不符合 Source 契约：${first ? `${first.path.join('.')} — ${first.message}` : '未知错误'}`,
    )
  }

  const raw = result.data
  if (raw.slug !== slug) {
    throw new Error(`${configPath} 的 slug ("${raw.slug}") 与目录名 ("${slug}") 不一致`)
  }

  /*
   * postgres 类型在**加载时**就把 SQL 与参数对清楚。
   *
   * 等到第一次调用才发现「这个工具没写 sql」或「参数名拼错了」，
   * 错误会以一条难懂的查询报错出现在任务中途；在这里失败，错误位置就是配置文件。
   */
  if (raw.type === 'postgres') {
    for (const tool of raw.tools) {
      if (!tool.sql) {
        throw new Error(`${configPath}：postgres 工具 "${tool.name}" 必须配置 sql`)
      }
      const properties =
        (tool.paramsSchema as { properties?: Record<string, unknown> }).properties ?? {}
      for (const name of tool.params) {
        if (!(name in properties)) {
          throw new Error(
            `${configPath}：工具 "${tool.name}" 的参数 "${name}" 没有在 paramsSchema 里声明`,
          )
        }
      }
    }
  }

  const config = resolveDeep(raw, paths)
  const guidePath = join(dir, config.guide)
  if (!existsSync(guidePath)) {
    throw new Error(`Source "${slug}" 声明了 guide "${config.guide}" 但文件不存在：${guidePath}`)
  }
  const guideText = readFileSync(guidePath, 'utf8')

  return {
    config,
    guideText,
    version: hashValue({ config, guide: guideText }).slice(0, 16),
    dir,
    configPath,
    guidePath,
  }
}

/** 加载 `sources/` 下的全部 Source。 */
export function loadAllSources(paths: DataPaths = dataPaths()): LoadedSource[] {
  if (!existsSync(paths.sources)) return []
  return readdirSync(paths.sources, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(paths.sources, entry.name, 'config.json')),
    )
    .map((entry) => loadSource(entry.name, paths))
    .sort((a, b) => a.config.slug.localeCompare(b.config.slug))
}
