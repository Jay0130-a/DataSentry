import { ErrorCode, fail } from '@datasentry/core'
import type { AgentAction, AgentBackend, AgentContext } from './backend.ts'
import type { ModelConfig } from './model-config.ts'
import { buildSystemPrompt, buildTaskPrompt, renderToolResult, toolCallIdFor } from './prompt.ts'

/**
 * OpenAI-compatible 后端。
 *
 * 千问（DashScope）、DeepSeek、Moonshot、vLLM、Ollama 等都提供这套协议，
 * 所以一个实现覆盖一片端点，只换 `baseUrl` + `model`。
 *
 * 为什么用 fetch 而不是引 OpenAI SDK：我们要的只是「发一个 JSON、解析一个 JSON」，
 * 而兼容端点对字段的支持参差不齐（有的不认 `max_completion_tokens`、
 * 有的 `tool_choice` 只接受字符串）。自己发请求能精确控制发什么，
 * 也便于在测试里注入假 fetch，不必联网。
 */

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body: string
    signal?: AbortSignal
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

export interface OpenAiBackendOptions {
  config: ModelConfig
  apiKey: string
  baseUrl: string
  fetchImpl?: FetchLike
  /** 单次请求超时。模型调用可能很慢，默认 120 秒。 */
  timeoutMs?: number
}

interface OpenAiToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      role?: string
      content?: string | null
      tool_calls?: OpenAiToolCall[]
    }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; type?: string; code?: string }
}

export class OpenAiCompatibleBackend implements AgentBackend {
  readonly name = 'openai-compatible'

  constructor(private readonly options: OpenAiBackendOptions) {}

  async nextAction(ctx: AgentContext): Promise<AgentAction> {
    const { config, baseUrl } = this.options
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

    const body = {
      model: config.name,
      max_tokens: config.maxTokens,
      stream: false,
      tool_choice: 'auto',
      messages: buildMessages(ctx),
      tools: ctx.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toParameters(tool.paramsSchema),
        },
      })),
    }

    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      })
    } catch (err) {
      const reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? `请求超时（${this.options.timeoutMs ?? 120_000}ms）`
          : err instanceof Error
            ? err.message
            : String(err)
      fail(ErrorCode.MODEL_CALL_FAILED, `连不上模型服务 ${url}：${reason}`, {
        model: config.name,
        baseUrl,
      })
    }

    const text = await response.text()
    let parsed: OpenAiResponse
    try {
      parsed = JSON.parse(text) as OpenAiResponse
    } catch {
      fail(
        ErrorCode.MODEL_CALL_FAILED,
        `模型返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 300)}`,
        { model: config.name, status: response.status },
      )
    }

    if (!response.ok) {
      fail(
        ErrorCode.MODEL_CALL_FAILED,
        describeHttpError(response.status, parsed),
        { model: config.name, status: response.status, error: parsed.error ?? null },
      )
    }

    if (process.env['DATASENTRY_MODEL_DEBUG'] === '1') {
      process.stderr.write(
        `[model] ${config.name} in=${parsed.usage?.prompt_tokens ?? '?'} out=${parsed.usage?.completion_tokens ?? '?'} finish=${parsed.choices?.[0]?.finish_reason ?? '?'}\n`,
      )
    }

    const choice = parsed.choices?.[0]
    if (!choice) {
      fail(ErrorCode.MODEL_CALL_FAILED, '模型返回里没有 choices', { model: config.name })
    }

    // 内容过滤属于「模型拒绝」，不能当成「说完了」——否则任务会带着不完整数据往下走。
    if (choice.finish_reason === 'content_filter') {
      fail(ErrorCode.MODEL_REFUSED, '模型因内容策略拒绝了这次请求', { model: config.name })
    }

    if (choice.finish_reason === 'length') {
      fail(
        ErrorCode.MODEL_CALL_FAILED,
        `模型输出被 max_tokens（${config.maxTokens}）截断，未得到完整动作`,
        { model: config.name, maxTokens: config.maxTokens },
      )
    }

    const toolCalls = choice.message?.tool_calls ?? []
    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolCalls.map((call, index) => parseToolCall(call, index, config.name)),
        ...(choice.message?.content ? { rationale: choice.message.content } : {}),
      }
    }

    const content = choice.message?.content?.trim()
    return {
      type: 'finish',
      summary: content && content.length > 0 ? content : '模型没有给出进一步动作',
    }
  }
}

function parseToolCall(
  call: OpenAiToolCall,
  index: number,
  model: string,
): { name: string; args: Record<string, unknown> } {
  const name = call.function?.name
  if (!name) {
    fail(ErrorCode.MODEL_CALL_FAILED, `第 ${index + 1} 个工具调用没有函数名`, { model })
  }

  const raw = call.function?.arguments ?? '{}'
  let args: unknown
  try {
    args = JSON.parse(raw)
  } catch {
    // 参数不是合法 JSON 时绝不能猜——猜出来的参数会带着错误的取值真的被执行。
    fail(
      ErrorCode.MODEL_CALL_FAILED,
      `工具 "${name}" 的参数不是合法 JSON：${raw.slice(0, 200)}`,
      { model, tool: name, raw },
    )
  }

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    fail(ErrorCode.MODEL_CALL_FAILED, `工具 "${name}" 的参数必须是对象`, { model, tool: name })
  }

  return { name, args: args as Record<string, unknown> }
}

function describeHttpError(status: number, parsed: OpenAiResponse): string {
  const detail = parsed.error?.message ?? parsed.error?.code ?? ''
  if (status === 401 || status === 403) {
    return `模型认证失败（HTTP ${status}）：${detail || '检查 API key 是否有效'}`
  }
  if (status === 429) {
    return `模型调用被限流（HTTP 429）：${detail}`
  }
  if (status === 404) {
    return `模型或端点不存在（HTTP 404）：${detail || '未知错误'}。请检查 baseUrl 与 model 名称`
  }
  return `模型调用失败（HTTP ${status}）：${detail || '未知错误'}`
}

function toParameters(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema['type'] === undefined) return { type: 'object', ...schema }
  return schema
}

/**
 * 把历史翻译成 Chat Completions 的多轮对话。
 *
 * 与 Claude 版的区别只有协议形状：
 * - 工具调用挂在 assistant 消息的 `tool_calls` 上
 * - 工具结果是独立的 `role: "tool"` 消息，靠 `tool_call_id` 配对
 */
export function buildMessages(ctx: AgentContext): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: buildSystemPrompt(ctx) },
    { role: 'user', content: buildTaskPrompt(ctx) },
  ]

  for (const [index, step] of ctx.history.entries()) {
    const toolCallId = toolCallIdFor('call_', index, step.toolName)

    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: step.toolName, arguments: JSON.stringify(step.args) },
        },
      ],
    })

    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      // 失败信息也作为 tool 内容回填，模型据此决定要不要停。
      content: renderToolResult(step),
    })
  }

  return messages
}

/** 用配置创建真实后端。 */
export function createOpenAiCompatibleBackend(options: {
  config: ModelConfig
  apiKey: string
  baseUrl: string
  fetchImpl?: FetchLike
}): OpenAiCompatibleBackend {
  return new OpenAiCompatibleBackend(options)
}
