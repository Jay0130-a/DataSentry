import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { credentialEnvVar } from '@datasentry/core'
import { erpHandlers } from './erp.ts'
import { financeHandlers } from './finance.ts'
import { loadSourceConfig } from './sourceConfig.ts'
import { assertHandlersCoverConfig, type ToolHandlerMap } from './types.ts'

/**
 * 进程内实现的 Source 服务端。HTTP 类型的 Source 不走这里。
 */
const REGISTRY: Record<string, ToolHandlerMap> = {
  erp: erpHandlers,
  finance: financeHandlers,
}

function textResult(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

function errorResult(code: string, message: string): {
  content: { type: 'text'; text: string }[]
  isError: true
} {
  return { ...textResult({ error: { code, message } }), isError: true }
}

/**
 * 以 MCP stdio 协议暴露一个模拟 Source。
 *
 * 工具清单直接来自 `sources/<slug>/config.json`——服务端不自己发明工具，
 * 也不自己定义参数结构，避免和后端认为的契约漂移。
 *
 * 注意：stdio 协议的 stdout 是 JSON-RPC 通道，任何调试输出都必须走 stderr。
 */
export async function startMcpServer(slug: string): Promise<void> {
  const config = loadSourceConfig(slug)
  const handlers = REGISTRY[slug]
  if (!handlers) {
    throw new Error(`没有为 Source "${slug}" 注册工具实现，可用：${Object.keys(REGISTRY).join(', ')}`)
  }
  assertHandlersCoverConfig(config, handlers)

  const server = new Server(
    { name: `datasentry-${slug}`, version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: config.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.paramsSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name
    const tool = config.tools.find((t) => t.name === toolName)
    if (!tool) {
      return errorResult('TOOL_NOT_REGISTERED', `Source "${slug}" 未声明工具 "${toolName}"`)
    }

    // 凭据在 spawn 时由 CredentialManager 注入到子进程环境，不进模型上下文。
    if (config.auth.type === 'static-token' && config.auth.credentialKey) {
      const envKey = credentialEnvVar(config.auth.credentialKey)
      if (!process.env[envKey]) {
        return errorResult(
          'CREDENTIAL_MISSING',
          `Source "${slug}" 缺少凭据 ${config.auth.credentialKey}（未注入 ${envKey}）`,
        )
      }
    }

    const handler = handlers[toolName]
    if (!handler) {
      return errorResult('TOOL_NOT_IMPLEMENTED', `工具 "${toolName}" 未实现`)
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    try {
      const execution = await handler(args, { slug, env: process.env })
      return textResult(execution)
    } catch (err) {
      return errorResult(
        'TOOL_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      )
    }
  })

  await server.connect(new StdioServerTransport())
}

const entrySlug = process.env['SOURCE_SLUG']
if (entrySlug) {
  startMcpServer(entrySlug).catch((err: unknown) => {
    process.stderr.write(
      `[mcp-server:${entrySlug}] 启动失败：${err instanceof Error ? err.stack : String(err)}\n`,
    )
    process.exit(1)
  })
}
