import Anthropic from '@anthropic-ai/sdk'
import { ErrorCode, fail } from '@datasentry/core'
import {
  supportsAdaptiveThinking,
  supportsEffort,
  type ModelConfig,
} from './model-config.ts'
import type { AgentAction, AgentBackend, AgentContext } from './backend.ts'
import {
  buildSystemPrompt,
  buildTaskPrompt,
  renderToolResult,
  toolCallIdFor,
} from './prompt.ts'

/** 客户端只需这么多能力，方便测试注入假实现，不必联网。 */
export interface ClaudeContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export interface ClaudeResponse {
  content: ClaudeContentBlock[]
  stop_reason?: string | null
  stop_details?: { category?: string | null; explanation?: string | null } | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

export interface ClaudeClientLike {
  messages: {
    create(body: Record<string, unknown>): Promise<ClaudeResponse>
  }
}

export interface ClaudeBackendOptions {
  config: ModelConfig
  client: ClaudeClientLike
}

/**
 * 真实模型后端（Claude）。
 *
 * 与 `MockAgentBackend` 的关系：两者实现同一个 `AgentBackend` 接口，
 * 因此**Harness 一行都没改**——权限链、Schema 校验、审批、状态机、事件轨迹
 * 对模型是谁完全无感。这是当初分层的主要理由。
 *
 * 它只做一件事：把 `AgentContext` 翻译成一次 Messages API 调用，
 * 再把响应翻译成「调用哪些工具」或「结束」。
 */
export class ClaudeAgentBackend implements AgentBackend {
  readonly name = 'claude'

  constructor(private readonly options: ClaudeBackendOptions) {}

  async nextAction(ctx: AgentContext): Promise<AgentAction> {
    const { config, client } = this.options

    const body: Record<string, unknown> = {
      model: config.name,
      max_tokens: config.maxTokens,
      system: buildSystemPrompt(ctx),
      messages: buildMessages(ctx),
      tools: ctx.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: toInputSchema(tool.paramsSchema),
      })),
      // 强制 tool_choice（any/tool）在 Opus 5.5 等模型上会 400；
      // 用 auto 并在 system prompt 里明确要求继续取数。
      tool_choice: { type: 'auto' },
    }

    // 只给支持的模型发这些参数：给老模型发 adaptive thinking 会直接 400。
    if (config.thinking && supportsAdaptiveThinking(config.name)) {
      body['thinking'] = { type: 'adaptive' }
    }
    if (supportsEffort(config.name)) {
      body['output_config'] = { effort: config.effort }
    }

    let response: ClaudeResponse
    try {
      response = await client.messages.create(body)
    } catch (err) {
      fail(ErrorCode.MODEL_CALL_FAILED, describeCallError(err), {
        model: config.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    if (process.env['DATASENTRY_MODEL_DEBUG'] === '1') {
      process.stderr.write(
        `[model] ${config.name} in=${response.usage?.input_tokens ?? '?'} out=${response.usage?.output_tokens ?? '?'} stop=${response.stop_reason ?? '?'}\n`,
      )
    }

    // 拒答是 HTTP 200，但 `content` 里没有可用的工具调用。
    // 不能当成「模型说完了」——那样任务会带着不完整的数据悄悄往下走。
    if (response.stop_reason === 'refusal') {
      fail(
        ErrorCode.MODEL_REFUSED,
        `模型拒绝了这次请求${response.stop_details?.category ? `（${response.stop_details.category}）` : ''}` +
          `${response.stop_details?.explanation ? `：${response.stop_details.explanation}` : ''}`,
        { model: config.name, stopDetails: response.stop_details ?? null },
      )
    }

    if (response.stop_reason === 'max_tokens') {
      fail(
        ErrorCode.MODEL_CALL_FAILED,
        `模型输出被 max_tokens（${config.maxTokens}）截断，未得到完整动作`,
        { model: config.name, maxTokens: config.maxTokens },
      )
    }

    const toolUses = response.content.filter((block) => block.type === 'tool_use')
    if (toolUses.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolUses.map((block) => ({
          name: block.name ?? '',
          args: (block.input ?? {}) as Record<string, unknown>,
        })),
        rationale: firstText(response.content) ?? undefined,
      }
    }

    return {
      type: 'finish',
      summary: firstText(response.content) ?? '模型没有给出进一步动作',
    }
  }
}

function firstText(content: readonly ClaudeContentBlock[]): string | null {
  const texts = content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
  return texts.length > 0 ? texts.join('\n').trim() : null
}

function describeCallError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return `模型认证失败：${err.message}（检查 API key 是否有效）`
  }
  if (err instanceof Anthropic.RateLimitError) {
    return `模型调用被限流：${err.message}`
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `连不上模型服务：${err.message}`
  }
  if (err instanceof Anthropic.APIError) {
    return `模型调用失败（HTTP ${err.status}）：${err.message}`
  }
  return `模型调用失败：${err instanceof Error ? err.message : String(err)}`
}

/**
 * 我们的工具契约本来就是 JSON Schema（和 MCP 共用同一份），
 * 所以这里几乎不用转换——只补一个 `type: object` 兜底。
 */
function toInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema['type'] === undefined) return { type: 'object', ...schema }
  return schema
}

/**
 * 把历史翻译成 Messages API 的多轮对话。
 *
 * API 是无状态的，每次都要重发完整历史。这里把每一步还原成
 * 「assistant 的 tool_use + user 的 tool_result」一对——
 * 即便模型一次给出多个工具调用，我们也是逐步执行、逐步记录，
 * 所以按步配对永远是合法的。
 */
export function buildMessages(ctx: AgentContext): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'user', content: buildTaskPrompt(ctx) },
  ]

  for (const [index, step] of ctx.history.entries()) {
    const toolUseId = toolCallIdFor('toolu_', index, step.toolName)
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: step.toolName, input: step.args }],
    })
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: renderToolResult(step),
          is_error: step.status !== 'succeeded',
        },
      ],
    })
  }

  return messages
}

/** 用配置创建真实客户端。 */
export function createClaudeClient(options: {
  apiKey: string
  baseUrl?: string | null
}): ClaudeClientLike {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  })
  // SDK 的 `messages.create` 有多个重载，这里按「最小可用接口」收窄，
  // 便于后端逻辑与测试用同一套形状，不必到处断言 SDK 类型。
  return client as unknown as ClaudeClientLike
}

export { supportsAdaptiveThinking, supportsEffort }
