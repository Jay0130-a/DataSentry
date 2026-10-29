import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions'
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  Tool as PiTool,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import { ErrorCode, fail } from '@datasentry/core'
import type { AgentAction, AgentBackend, AgentContext, AgentStepRecord } from './backend.ts'
import type { ModelConfig } from './model-config.ts'
import { buildSystemPrompt, buildTaskPrompt, renderToolResult, toolCallIdFor } from './prompt.ts'

/**
 * pi-ai 的模型层后端。
 *
 * 与 `ClaudeAgentBackend` / `OpenAiCompatibleBackend` 的区别只在「谁来发请求」：
 * 那两者各自对着一个厂商的 SDK 或 HTTP 形状写代码，这一个交给 pi-ai 的
 * provider 适配层——42 个内置 provider 共用同一份调用代码。
 *
 * **它仍然只做一步**：把 `AgentContext` 翻译成一次请求，拿回一次响应。
 * 循环、权限链、检查点、审批都还在我们自己的 AgentLoop 里——这是第 1 步刻意划的界。
 */
export interface PiCompleteOptions {
  apiKey?: string
  maxTokens?: number
  signal?: AbortSignal
}

/** 只需要这么多能力，测试可以注入假实现，不必联网。 */
export interface PiAiClient {
  completeSimple(model: Model<Api>, context: Context, options?: PiCompleteOptions): Promise<AssistantMessage>
  /** 供 pi 的 Agent 循环使用：流式入口。 */
  streamSimple(model: Model<Api>, context: Context, options?: PiCompleteOptions): unknown
}

export interface PiAiBackendOptions {
  config: ModelConfig
  model: Model<Api>
  apiKey: string
  client?: PiAiClient
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/** `builtinModels()` 每次构造 42 个 provider，进程内复用一份即可。 */
let builtinModelsCache: ReturnType<typeof builtinModels> | null = null

function builtinModelRegistry(): ReturnType<typeof builtinModels> {
  builtinModelsCache ??= builtinModels()
  return builtinModelsCache
}

/**
 * 按 provider + model id 解析出 pi 的 `Model` 对象。
 *
 * 解析失败时把可用的 provider 列出来——配置写错时最想知道的就是「到底有哪些能选」。
 */
export function resolvePiModel(provider: string, modelId: string): Model<Api> {
  const models = builtinModelRegistry()
  const model = models.getModel(provider, modelId)
  if (model) return model

  const providers = models
    .getProviders()
    .map((p) => p.id)
    .sort()
    .join('、')

  fail(
    ErrorCode.MODEL_CONFIG_INVALID,
    `pi 不认识模型 "${provider}/${modelId}"。可用的 provider：${providers}`,
    { provider, modelId },
  )
}

/**
 * 自定义 provider 的 id。
 *
 * 用于「pi 目录里没有、但给了 baseUrl」的场景——比如阿里云标准 DashScope
 * （`dashscope.aliyuncs.com`）不在 pi 的内置目录里，它内置的是订阅制端点
 * `token-plan.*.maas.aliyuncs.com`。有这一条，pi 就能指向任意 OpenAI 兼容端点。
 */
export const CUSTOM_PI_PROVIDER = 'datasentry-custom'

/**
 * 解析出这次要用的模型与客户端。
 *
 * 顺序：
 * 1. pi 内置目录里找得到 → 用内置 provider（端点、模型元数据都由 pi 管）
 * 2. 找不到但配置了 baseUrl → 用 `openai-completions` 适配器造一个自定义 provider
 * 3. 都没有 → 报错
 */
export function createPiRuntime(
  config: ModelConfig,
  apiKey: string,
): { model: Model<Api>; client: PiAiClient } {
  const builtin = builtinModelRegistry()
  const found = builtin.getModel(config.piProvider, config.name)
  if (found) {
    return { model: found, client: builtin as unknown as PiAiClient }
  }

  if (!config.baseUrl) {
    // 走到这里说明 provider/model 都不在目录里，且没有给端点。
    // 直接报错比给出一个含糊的「模型不存在」更有用。
    resolvePiModel(config.piProvider, config.name)
  }

  const models = createModels()
  models.setProvider(
    createProvider({
      id: CUSTOM_PI_PROVIDER,
      baseUrl: config.baseUrl as string,
      auth: {
        apiKey: {
          name: `${config.apiKeyEnv} / DATASENTRY_MODEL_API_KEY`,
          async resolve({
            credential,
            ctx,
          }: {
            credential?: { key?: string }
            ctx: { env(name: string): Promise<string | undefined> }
          }) {
            const key =
              credential?.key ??
              (await ctx.env(config.apiKeyEnv)) ??
              (await ctx.env('DATASENTRY_MODEL_API_KEY'))
            if (!key) return undefined
            return { auth: { apiKey: key }, source: config.apiKeyEnv }
          },
        },
      },
      models: [
        {
          id: config.name,
          name: config.name,
          api: 'openai-completions',
          provider: CUSTOM_PI_PROVIDER,
          baseUrl: config.baseUrl as string,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131_072,
          maxTokens: config.maxTokens,
          reasoning: false,
        } as never,
      ],
      api: {
        stream: openaiCompletions.stream,
        streamSimple: openaiCompletions.streamSimple,
      },
    } as never),
  )

  const model = models.getModel(CUSTOM_PI_PROVIDER, config.name)
  if (!model) {
    fail(ErrorCode.MODEL_CONFIG_INVALID, '自定义 provider 注册后仍取不到模型', {
      model: config.name,
      baseUrl: config.baseUrl,
    })
  }

  // 显式给了 key，就不依赖 provider 的 auth 解析。
  void apiKey
  return { model, client: models as unknown as PiAiClient }
}

export class PiAiBackend implements AgentBackend {
  readonly name: string
  private readonly client: PiAiClient

  constructor(private readonly options: PiAiBackendOptions) {
    this.name = `pi:${options.model.provider}/${options.model.id}`
    this.client = options.client ?? (builtinModelRegistry() as unknown as PiAiClient)
  }

  async nextAction(ctx: AgentContext): Promise<AgentAction> {
    let response: AssistantMessage
    try {
      response = await this.client.completeSimple(
        this.options.model,
        {
          systemPrompt: buildSystemPrompt(ctx),
          messages: buildMessages(ctx, this.options.model),
          tools: ctx.tools.map(toPiTool),
        },
        {
          apiKey: this.options.apiKey,
          maxTokens: this.options.config.maxTokens,
        },
      )
    } catch (err) {
      fail(ErrorCode.MODEL_CALL_FAILED, describeCallError(err), {
        model: `${this.options.model.provider}/${this.options.model.id}`,
      })
    }

    if (process.env['DATASENTRY_MODEL_DEBUG'] === '1') {
      process.stderr.write(
        `[model] pi:${this.options.model.id} in=${response.usage.input} out=${response.usage.output} stop=${response.stopReason}\n`,
      )
    }

    switch (response.stopReason) {
      case 'error':
        fail(
          ErrorCode.MODEL_CALL_FAILED,
          `模型返回错误：${response.errorMessage ?? '未说明原因'}`,
          { model: this.options.model.id },
        )
      case 'aborted':
        fail(ErrorCode.MODEL_CALL_FAILED, '模型调用被中断', { model: this.options.model.id })
      case 'length':
        fail(
          ErrorCode.MODEL_CALL_FAILED,
          `模型输出被 max_tokens（${this.options.config.maxTokens}）截断，未得到完整动作`,
          { model: this.options.model.id, maxTokens: this.options.config.maxTokens },
        )
      default:
        break
    }

    const toolCalls = response.content.filter((item): item is ToolCall => item.type === 'toolCall')
    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolCalls.map(toAgentCall),
        ...(textOf(response.content) ? { rationale: textOf(response.content)! } : {}),
      }
    }

    return {
      type: 'finish',
      summary: textOf(response.content) ?? '模型没有给出进一步动作',
    }
  }
}

function toPiTool(tool: AgentContext['tools'][number]): PiTool {
  // 我们的工具契约本来就是 JSON Schema，pi 的 TSchema（TypeBox）在运行时是同一个形状。
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.paramsSchema as unknown as PiTool['parameters'],
  }
}

function toAgentCall(call: ToolCall): { name: string; args: Record<string, unknown> } {
  // pi 在参数不是合法 JSON 时会置 `argumentsError` 并把 arguments 设为 {}。
  // 绝不能拿这个空对象去执行——那会带着错误取值真的打到数据源上。
  if (call.argumentsError) {
    fail(ErrorCode.MODEL_CALL_FAILED, `工具 "${call.name}" 的参数不是合法 JSON：${call.argumentsError}`, {
      tool: call.name,
    })
  }
  return { name: call.name, args: call.arguments as Record<string, unknown> }
}

function textOf(content: AssistantMessage['content']): string | null {
  const texts = content
    .filter((item): item is Extract<AssistantMessage['content'][number], { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
  return texts.length > 0 ? texts.join('\n').trim() || null : null
}

/**
 * 把我们的执行历史翻译成 pi 的消息序列。
 *
 * API 是无状态的，每一步都要重发完整历史。历史里既有「模型发起的调用」也有
 * 「工具的结果」，所以要成对还原：assistant(toolCall) + toolResult。
 */
export function buildMessages(ctx: AgentContext, model: Model<Api>): Message[] {
  const messages: Message[] = [
    { role: 'user', content: buildTaskPrompt(ctx), timestamp: Date.now() },
  ]

  for (const [index, step] of ctx.history.entries()) {
    const toolCallId = toolCallIdFor('pi_', index, step.toolName)

    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: toolCallId,
          name: step.toolName,
          arguments: step.args as Record<string, never>,
        },
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: 'toolUse',
      timestamp: Date.now(),
    })

    messages.push({
      role: 'toolResult',
      toolCallId,
      toolName: step.toolName,
      content: [{ type: 'text', text: renderToolResult(step) }],
      isError: step.status !== 'succeeded',
      timestamp: Date.now(),
    })
  }

  return messages
}

function describeCallError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return `模型调用失败：${message}`
}

export type { AgentStepRecord }
