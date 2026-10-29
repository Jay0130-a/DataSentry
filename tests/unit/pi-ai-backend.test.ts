import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import { ErrorCode, isDataSentryError } from '@datasentry/core'
import {
  buildMessages,
  PiAiBackend,
  resolvePiModel,
  type PiAiClient,
} from '@datasentry/backend/agent/pi-ai-backend.ts'
import type { AgentContext, AgentStepRecord } from '@datasentry/backend/agent/backend.ts'
import type { ModelConfig } from '@datasentry/backend/agent/model-config.ts'

const USAGE: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'pi',
    name: 'claude-opus-5-5',
    baseUrl: null,
    apiKeyEnv: 'DATASENTRY_MODEL_API_KEY',
    baseUrlEnv: 'DATASENTRY_MODEL_BASE_URL',
    maxTokens: 16_000,
    effort: 'high',
    thinking: true,
    piProvider: 'anthropic',
    ...overrides,
  }
}

const TOOLS = [
  {
    name: 'datasentry__read_source_guide',
    title: '读取 guide',
    description: '读取 Source 的 guide',
    paramsSchema: { type: 'object', properties: { sourceSlug: { type: 'string' } } },
    guideRead: true,
  },
  {
    name: 'mcp__erp__fetch_revenue',
    title: '查询收入',
    description: '按期间查询收入',
    paramsSchema: { type: 'object', properties: { period: { type: 'string' } } },
    guideRead: false,
  },
]

function ctx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'sess_1',
    workspaceId: 'group-finance',
    request: '出 2025 年 9 月的经营月报',
    input: { period: '2025-09' },
    skill: {
      name: 'monthly-operation-report',
      description: '经营月报',
      body: '# 经营月报\n1. 先读 guide',
      requiredSources: ['erp', 'finance'],
      stopRules: ['数据齐了就停'],
    },
    tools: TOOLS,
    activeSourceSlugs: ['erp', 'finance'],
    history: [],
    ...overrides,
  }
}

function reply(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  const model = resolvePiModel('anthropic', 'claude-opus-5-5')
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: USAGE,
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  }
}

function fakeClient(response: AssistantMessage | (() => Promise<never>)): {
  client: PiAiClient
  calls: { context: unknown; options: unknown }[]
} {
  const calls: { context: unknown; options: unknown }[] = []
  return {
    calls,
    client: {
      async completeSimple(_model, context, options) {
        calls.push({ context, options })
        if (typeof response === 'function') return response()
        return response
      },
      // 这个测试只覆盖 completeSimple；流式入口由 pi-loop 的测试覆盖。
      streamSimple() {
        throw new Error('not used in this test')
      },
    },
  }
}

function makeBackend(fake: ReturnType<typeof fakeClient>): PiAiBackend {
  return new PiAiBackend({
    config: config(),
    model: resolvePiModel('anthropic', 'claude-opus-5-5'),
    apiKey: 'sk-test',
    client: fake.client,
  })
}

describe('pi-ai 模型解析', () => {
  it('能离线解析内置 provider 的模型', () => {
    const model = resolvePiModel('anthropic', 'claude-opus-5-5')
    expect(model.id).toBe('claude-opus-5-5')
    expect(model.api).toBe('anthropic-messages')
    expect(model.baseUrl).toContain('anthropic.com')
  })

  it('国内 provider 也在目录里', () => {
    const qwen = resolvePiModel('qwen-token-plan', 'qwen3.7-max')
    expect(qwen.api).toBe('openai-completions')
    expect(qwen.baseUrl).toContain('aliyuncs.com')

    const moonshot = resolvePiModel('moonshotai', 'kimi-k2.6')
    expect(moonshot.provider).toBe('moonshotai')
  })

  it('模型名写错时立刻报错，并列出可用 provider', () => {
    try {
      resolvePiModel('anthropic', 'no-such-model')
      throw new Error('本应失败')
    } catch (err) {
      expect(isDataSentryError(err)).toBe(true)
      if (isDataSentryError(err)) {
        expect(err.code).toBe(ErrorCode.MODEL_CONFIG_INVALID)
        expect(err.message).toContain('qwen-token-plan')
      }
    }
  })
})

describe('pi-ai 后端 · 请求构造', () => {
  it('把工具契约原样当作 JSON Schema 传过去', async () => {
    const fake = fakeClient(reply({ content: [{ type: 'text', text: '好' }] }))
    await makeBackend(fake).nextAction(ctx())

    const context = fake.calls[0]!.context as {
      systemPrompt: string
      messages: unknown[]
      tools: { name: string; parameters: unknown }[]
    }
    expect(context.systemPrompt).toContain('monthly-operation-report')
    expect(context.messages).toHaveLength(1)
    expect(context.tools.map((t) => t.name)).toEqual([
      'datasentry__read_source_guide',
      'mcp__erp__fetch_revenue',
    ])
    expect(context.tools[1]!.parameters).toMatchObject({ type: 'object' })
  })

  it('密钥与 maxTokens 透传给 pi', async () => {
    const fake = fakeClient(reply({ content: [{ type: 'text', text: '好' }] }))
    await makeBackend(fake).nextAction(ctx())

    expect(fake.calls[0]!.options).toMatchObject({ apiKey: 'sk-test', maxTokens: 16_000 })
  })

  it('历史还原成 assistant(toolCall) + toolResult 成对出现', () => {
    const model = resolvePiModel('anthropic', 'claude-opus-5-5')
    const history: AgentStepRecord[] = [
      {
        step: 0,
        toolName: 'datasentry__read_source_guide',
        args: { sourceSlug: 'erp' },
        status: 'succeeded',
        note: '已读取 erp 的 guide',
      },
      {
        step: 1,
        toolName: 'mcp__erp__fetch_revenue',
        args: { period: '2025-09' },
        status: 'succeeded',
        result: {
          resultId: 'res_1',
          toolName: 'mcp__erp__fetch_revenue',
          sourceRef: { slug: 'erp', tool: 'fetch_revenue', dataVersion: 'erp:2025-09:v1' },
          completeness: 'full',
          data: { totalRevenue: 100 },
          meta: { dataVersion: 'erp:2025-09:v1', completeness: 'full', rowCount: 3 },
        },
      },
      {
        step: 2,
        toolName: 'mcp__finance__fetch_expense_detail',
        args: { period: '2025-09' },
        status: 'denied',
        errorCode: 'APPROVAL_REQUIRED',
        errorMessage: '需要审批',
      },
    ]

    const messages = buildMessages(ctx({ history }), model)
    // 1 条任务 + 每步 2 条
    expect(messages).toHaveLength(1 + history.length * 2)

    for (let i = 0; i < history.length; i += 1) {
      const assistant = messages[1 + i * 2] as unknown as {
        role: string
        content: Array<Record<string, unknown>>
      }
      const tool = messages[2 + i * 2] as unknown as Record<string, unknown>

      expect(assistant.role).toBe('assistant')
      expect(assistant.content[0]!['type']).toBe('toolCall')
      expect(tool['role']).toBe('toolResult')
      // 配对必须一致，否则 provider 会拒绝
      expect(tool['toolCallId']).toBe(assistant.content[0]!['id'])
    }

    // 成功的结果带数据，失败的标 isError
    // 布局：0=任务，1/2=第 0 步，3/4=第 1 步，5/6=第 2 步
    const success = messages[4] as unknown as {
      content: Array<{ text: string }>
      isError: boolean
    }
    expect(success.content[0]!.text).toContain('totalRevenue')
    expect(success.isError).toBe(false)

    const denied = messages[6] as unknown as {
      content: Array<{ text: string }>
      isError: boolean
    }
    expect(denied.isError).toBe(true)
    expect(denied.content[0]!.text).toContain('需要审批')
  })
})

describe('pi-ai 后端 · 响应解析', () => {
  it('toolCall 转成我们的工具调用', async () => {
    const fake = fakeClient(
      reply({
        content: [
          { type: 'text', text: '先查收入' },
          {
            type: 'toolCall',
            id: 'pi_1',
            name: 'mcp__erp__fetch_revenue',
            arguments: { period: '2025-09' },
          },
        ],
        stopReason: 'toolUse',
      }),
    )

    const action = await makeBackend(fake).nextAction(ctx())
    expect(action).toMatchObject({
      type: 'tool_calls',
      calls: [{ name: 'mcp__erp__fetch_revenue', args: { period: '2025-09' } }],
      rationale: '先查收入',
    })
  })

  it('只有文本就结束', async () => {
    const fake = fakeClient(reply({ content: [{ type: 'text', text: '数据已取齐。' }] }))
    expect(await makeBackend(fake).nextAction(ctx())).toEqual({
      type: 'finish',
      summary: '数据已取齐。',
    })
  })

  it('参数 JSON 解析失败时直接报错，绝不执行空参数', async () => {
    const fake = fakeClient(
      reply({
        content: [
          {
            type: 'toolCall',
            id: 'pi_1',
            name: 'mcp__erp__fetch_revenue',
            arguments: {},
            argumentsError: 'Unexpected token',
          },
        ],
        stopReason: 'toolUse',
      }),
    )

    try {
      await makeBackend(fake).nextAction(ctx())
      throw new Error('本应失败')
    } catch (err) {
      expect(isDataSentryError(err)).toBe(true)
      if (isDataSentryError(err)) {
        expect(err.code).toBe(ErrorCode.MODEL_CALL_FAILED)
        expect(err.message).toContain('不是合法 JSON')
      }
    }
  })

  it('stopReason=error 时报错，不当作正常结束', async () => {
    const fake = fakeClient(reply({ stopReason: 'error', errorMessage: 'overloaded' }))
    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('overloaded'),
    })
  })

  it('stopReason=length 时报截断，不返回半截动作', async () => {
    const fake = fakeClient(reply({ stopReason: 'length' }))
    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      message: expect.stringContaining('截断'),
    })
  })

  it('客户端抛异常时包成 MODEL_CALL_FAILED', async () => {
    const fake = fakeClient(() => Promise.reject(new Error('ECONNREFUSED')))
    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('ECONNREFUSED'),
    })
  })
})
