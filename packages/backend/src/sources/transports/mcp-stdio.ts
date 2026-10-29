import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { DataPaths, SourceConfig } from '@datasentry/core'
import type { CredentialManager } from '../../credentials/manager.ts'
import type { LoadedSource } from '../loader.ts'
import { parseExecutionPayload, ToolExecutionError, type SourceTransport } from './types.ts'

type McpStdioConfig = Extract<SourceConfig, { type: 'mcp-stdio' }>

/** process.env 里有 undefined，StdioClientTransport 只接受 string。 */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * MCP stdio 接入（PRD FR-01.2）。
 *
 * 每个 Source 起一个子进程，通过标准 MCP 协议通信。凭据在这里注入到子进程环境，
 * 之后就不再出现在任何传递给模型的内容里。
 */
export async function createMcpStdioTransport(
  source: LoadedSource,
  deps: { paths: DataPaths; credentials: CredentialManager },
): Promise<SourceTransport> {
  const config = source.config as McpStdioConfig
  const { transport } = config

  const credentialKeys = config.auth.credentialKey ? [config.auth.credentialKey] : []
  const env = {
    ...cleanEnv(process.env),
    ...transport.env,
    // 凭据注入点：只进子进程环境。
    ...deps.credentials.envFor(credentialKeys),
  }

  const client = new Client({ name: 'datasentry-backend', version: '0.1.0' })
  const stdio = new StdioClientTransport({
    command: transport.command,
    args: transport.args,
    env,
    cwd: deps.paths.root,
    stderr: 'pipe',
  })

  await client.connect(stdio)

  // 对账：服务端实际提供的工具必须覆盖 config 声明的工具，
  // 否则说明「配置说有这么个工具」和「服务真能调」已经不一致了。
  const listed = await client.listTools()
  const served = new Set(listed.tools.map((t) => t.name))
  const missing = config.tools.filter((t) => !served.has(t.name)).map((t) => t.name)

  return {
    slug: config.slug,
    async call(toolName, args) {
      if (missing.includes(toolName)) {
        throw new ToolExecutionError(
          'TOOL_NOT_REGISTERED',
          `MCP 服务 "${config.slug}" 未提供工具 "${toolName}"`,
        )
      }

      const result = (await client.callTool({ name: toolName, arguments: args })) as {
        content?: { type: string; text?: string }[]
        isError?: boolean
      }

      const textPart = result.content?.find((part) => part.type === 'text' && part.text)
      if (!textPart?.text) {
        throw new ToolExecutionError(
          'TOOL_RESULT_SCHEMA_INVALID',
          `MCP 服务 "${config.slug}" 的工具 "${toolName}" 没有返回文本内容`,
        )
      }

      // isError 时 payload 里带 { error: { code, message } }，由 parseExecutionPayload 抛出。
      return parseExecutionPayload(textPart.text)
    },
    async close() {
      await client.close()
    },
  }
}
