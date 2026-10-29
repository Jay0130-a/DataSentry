import {
  buildToolName,
  dataPaths,
  type DataPaths,
  type SourceConfig,
  type SourceToolConfig,
} from '@datasentry/core'
import type { CredentialManager } from '../credentials/manager.ts'
import { registerBuiltinLocalHandlers } from './local-handlers/index.ts'
import { loadAllSources, type LoadedSource } from './loader.ts'
import { ManagedServiceManager } from './managed-services.ts'
import { createHttpTransport } from './transports/http.ts'
import { createLocalTransport } from './transports/local.ts'
import { createMcpStdioTransport } from './transports/mcp-stdio.ts'
import { createPostgresTransport } from './transports/postgres.ts'
import type { SourceTransport } from './transports/types.ts'

/** 注册到 Agent 的一个受控工具。 */
export interface RegisteredTool {
  /** 统一命名 `mcp__{source}__{tool}`（PRD FR-01 验收标准）。 */
  name: string
  kind: 'source' | 'builtin'
  sourceSlug: string
  toolName: string
  title: string
  description: string
  paramsSchema: Record<string, unknown>
  resultSchema: Record<string, unknown>
  sensitivity: SourceToolConfig['sensitivity']
  sideEffect: SourceToolConfig['sideEffect']
  requiresGuide: boolean
  /** Source config + guide 摘要；审批绑定用它。 */
  toolVersion: string
}

export interface BuiltSource {
  slug: string
  type: SourceConfig['type']
  version: string
  transport: SourceTransport
}

export interface BuiltSources {
  tools: RegisteredTool[]
  transports: Map<string, SourceTransport>
  close: () => Promise<void>
}

export interface SourceServerBuilderDeps {
  paths?: DataPaths
  credentials: CredentialManager
  managed?: ManagedServiceManager
}

/**
 * SourceServerBuilder（PRD §5 流程中的一步）。
 *
 * 把「磁盘上的 Source 配置」变成「Agent 可调用且受控的工具 + 可执行的传输」。
 * 三种接入方式的差异在这里收敛，上层拿到的是统一的 `RegisteredTool` 列表和
 * 按 slug 索引的 `SourceTransport`。
 */
export class SourceServerBuilder {
  private readonly paths: DataPaths
  private readonly credentials: CredentialManager
  private readonly managed: ManagedServiceManager

  constructor(deps: SourceServerBuilderDeps) {
    this.paths = deps.paths ?? dataPaths()
    this.credentials = deps.credentials
    this.managed = deps.managed ?? new ManagedServiceManager()
    registerBuiltinLocalHandlers()
  }

  /** 只加载配置、不建立连接——用于列表接口与配置诊断。 */
  loadAll(): LoadedSource[] {
    return loadAllSources(this.paths)
  }

  /**
   * 为指定 slug 构建传输与工具。`slugs` 为空表示全部。
   *
   * 注意：这里不做权限判断。工具建出来不等于可用——能不能调用由 PreToolUse 决定。
   */
  async build(slugs?: readonly string[]): Promise<BuiltSources> {
    const all = this.loadAll()
    const selected = slugs ? all.filter((s) => slugs.includes(s.config.slug)) : all

    const missing = (slugs ?? []).filter((slug) => !all.some((s) => s.config.slug === slug))
    if (missing.length > 0) {
      throw new Error(`以下 Source 不存在：${missing.join(', ')}`)
    }

    const transports = new Map<string, SourceTransport>()
    const tools: RegisteredTool[] = []

    try {
      for (const source of selected) {
        const transport = await this.createTransport(source)
        transports.set(source.config.slug, transport)
        for (const tool of source.config.tools) {
          tools.push(toRegisteredTool(source, tool))
        }
      }
    } catch (err) {
      // 构建到一半失败时，把已经起来的子进程收掉，不留孤儿。
      await Promise.allSettled([...transports.values()].map((t) => t.close()))
      throw err
    }

    return {
      tools,
      transports,
      close: async () => {
        await Promise.allSettled([...transports.values()].map((t) => t.close()))
        await this.managed.closeAll()
      },
    }
  }

  private async createTransport(source: LoadedSource): Promise<SourceTransport> {
    const config = source.config
    switch (config.type) {
      case 'mcp-stdio':
        return createMcpStdioTransport(source, {
          paths: this.paths,
          credentials: this.credentials,
        })

      case 'http': {
        // managed 服务先拉起来，拿到真实端口再建传输——对外部服务则是直接用 baseUrl。
        let baseUrl = config.transport.baseUrl ?? ''
        if (config.transport.managed) {
          const service = await this.managed.ensure(config.transport.managed.module, {
            paths: this.paths,
            port: config.transport.managed.port,
          })
          baseUrl = service.url
        }
        return createHttpTransport(source, baseUrl, {
          paths: this.paths,
          credentials: this.credentials,
        })
      }

      case 'local':
        return createLocalTransport(source, { paths: this.paths })

      case 'postgres':
        return createPostgresTransport(source, { paths: this.paths })
    }
  }
}

function toRegisteredTool(source: LoadedSource, tool: SourceToolConfig): RegisteredTool {
  return {
    name: buildToolName(source.config.slug, tool.name),
    kind: 'source',
    sourceSlug: source.config.slug,
    toolName: tool.name,
    title: tool.title,
    description: tool.description,
    paramsSchema: tool.paramsSchema,
    resultSchema: tool.resultSchema,
    sensitivity: tool.sensitivity,
    sideEffect: tool.sideEffect,
    requiresGuide: tool.requiresGuide,
    toolVersion: source.version,
  }
}
