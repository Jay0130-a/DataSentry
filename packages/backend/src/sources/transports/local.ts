import type { DataPaths, SourceConfig, ToolExecution } from '@datasentry/core'
import type { CredentialManager } from '../../credentials/manager.ts'
import type { LoadedSource } from '../loader.ts'
import { ToolExecutionError, type SourceTransport } from './types.ts'

export interface LocalHandlerContext {
  options: Record<string, unknown>
  paths: DataPaths
  /**
   * 凭据管理器。handler 需要密钥时用它按**变量名**取，
   * 密钥本身绝不进 args、事件或日志。
   */
  credentials?: CredentialManager
}

export type LocalToolHandler = (
  args: Record<string, unknown>,
  ctx: LocalHandlerContext,
) => Promise<ToolExecution>

export type LocalToolHandlerMap = Record<string, LocalToolHandler>

/** 内置 handler 的注册表（PRD FR-01.2 的 `local` 类型）。 */
const registry: Record<string, LocalToolHandlerMap> = {}

export function registerLocalHandlers(module: string, handlers: LocalToolHandlerMap): void {
  registry[module] = handlers
}

export function registeredLocalModules(): string[] {
  return Object.keys(registry).sort()
}

/**
 * local 接入：handler 在后端进程内执行。
 *
 * 与 mcp-stdio / http 的区别只是「代码在哪跑」，权限、Schema 校验、
 * 事件记录这些边界完全共用——local 不等于「绕过检查的近路」。
 */
export function createLocalTransport(
  source: LoadedSource,
  deps: { paths: DataPaths; credentials?: CredentialManager },
): SourceTransport {
  const config = source.config as Extract<SourceConfig, { type: 'local' }>
  const module = config.transport.module
  const handlers = registry[module]

  if (!handlers) {
    throw new ToolExecutionError(
      'SOURCE_CONFIG_INVALID',
      `local Source "${config.slug}" 引用了未注册的 handler 模块 "${module}"，已注册：${registeredLocalModules().join(', ') || '（无）'}`,
    )
  }

  // 建连接时就核对 handler 是否齐全，不要等到任务跑到一半才发现某步没有实现。
  const missing = config.tools
    .map((tool) => tool.handler ?? tool.name)
    .filter((name) => !handlers[name])
  if (missing.length > 0) {
    throw new ToolExecutionError(
      'SOURCE_CONFIG_INVALID',
      `local Source "${config.slug}" 的模块 "${module}" 未实现这些 handler：${missing.join(', ')}`,
    )
  }

  const ctx: LocalHandlerContext = {
    options: config.transport.options,
    paths: deps.paths,
    ...(deps.credentials ? { credentials: deps.credentials } : {}),
  }

  return {
    slug: config.slug,
    async call(toolName, args) {
      const decorated = config.tools.find((t) => t.name === toolName)
      const handlerName = decorated?.handler ?? toolName
      const handler = handlers[handlerName]
      if (!handler) {
        throw new ToolExecutionError(
          'TOOL_NOT_REGISTERED',
          `local Source "${config.slug}" 未实现工具 "${toolName}"（handler: ${handlerName}）`,
        )
      }
      return handler(args, ctx)
    },
    async close() {
      // 进程内执行，无资源需要释放。
    },
  }
}
