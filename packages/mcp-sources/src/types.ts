import type { SourceConfig, ToolExecution } from '@datasentry/core'

/**
 * 一次工具执行的结果载荷。信封（resultId / sourceRef / completeness）由后端补。
 * 契约定义在 core，模拟服务端与后端共用同一份。
 */
export type { ToolExecution }

export interface ToolContext {
  /** 本 Source 的 slug */
  slug: string
  /** 子进程环境（含由 CredentialManager 注入的凭据变量） */
  env: NodeJS.ProcessEnv
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolExecution>

export type ToolHandlerMap = Record<string, ToolHandler>

/** 本 Source 声明的工具名集合，与服务端实际注册的 handler 必须一致。 */
export function assertHandlersCoverConfig(
  config: SourceConfig,
  handlers: ToolHandlerMap,
): void {
  const declared = new Set(config.tools.map((t) => t.name))
  const implemented = new Set(Object.keys(handlers))

  const missing = [...declared].filter((name) => !implemented.has(name))
  if (missing.length > 0) {
    throw new Error(
      `[${config.slug}] config.json 声明了未实现的工具：${missing.join(', ')}`,
    )
  }

  const extra = [...implemented].filter((name) => !declared.has(name))
  if (extra.length > 0) {
    throw new Error(
      `[${config.slug}] 实现了 config.json 未声明的工具：${extra.join(', ')}`,
    )
  }
}
