import type { DataPaths, SourceConfig } from '@datasentry/core'
import type { CredentialManager } from '../../credentials/manager.ts'
import type { LoadedSource } from '../loader.ts'
import { parseExecutionPayload, ToolExecutionError, type SourceTransport } from './types.ts'

type HttpConfig = Extract<SourceConfig, { type: 'http' }>

/**
 * 拼接工具 URL，保留 baseUrl 的路径前缀。
 *
 * `new URL('/tools/x', 'https://host/api/v1')` 会把 `/api/v1` 丢掉；
 * 挂在 `/api/v1` 下的真实企业网关会因此全部 404。
 */
export function buildToolUrl(baseUrl: string, toolPath: string, toolName: string): string {
  const base = new URL(baseUrl)
  const path = toolPath.replaceAll('{tool}', toolName)
  const prefix = base.pathname.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  return new URL(`${prefix}/${suffix}`, base.origin).toString()
}

/**
 * HTTP 接入（PRD FR-01.2）。
 *
 * `baseUrl` 指向外部服务时是真实企业系统的接入形态；指向 managed 服务时
 * 是本地模拟。两者的调用代码完全一致——这正是把模拟服务做成真 HTTP 的意义。
 */
export function createHttpTransport(
  source: LoadedSource,
  baseUrl: string,
  deps: { paths: DataPaths; credentials: CredentialManager },
): SourceTransport {
  const config = source.config as HttpConfig
  const { transport } = config

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // 凭据注入点：只进请求头。
  if (config.auth.credentialKey) {
    headers['authorization'] = `Bearer ${deps.credentials.require(config.auth.credentialKey)}`
  }

  return {
    slug: config.slug,
    async call(toolName, args) {
      const url = buildToolUrl(baseUrl, transport.toolPath, toolName)

      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ params: args }),
          signal: AbortSignal.timeout(transport.timeoutMs),
        })
      } catch (err) {
        throw new ToolExecutionError(
          'TOOL_EXECUTION_FAILED',
          `调用 "${config.slug}.${toolName}" 失败：${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const text = await response.text()
      if (!response.ok) {
        // 服务端可能返回 { error: { code, message } }，交给 parse 统一处理
        try {
          return parseExecutionPayload(text)
        } catch (err) {
          if (err instanceof ToolExecutionError) throw err
        }
        throw new ToolExecutionError(
          'TOOL_EXECUTION_FAILED',
          `"${config.slug}.${toolName}" 返回 HTTP ${response.status}：${text.slice(0, 200)}`,
        )
      }

      return parseExecutionPayload(text)
    },
    async close() {
      // HTTP 是无状态调用，没有连接要关。
    },
  }
}
