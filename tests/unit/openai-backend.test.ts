import { describe, expect, it } from 'vitest'
import { ErrorCode, isDataSentryError } from '@datasentry/core'
import {
  buildMessages,
  OpenAiCompatibleBackend,
  type FetchLike,
} from '@datasentry/backend/agent/openai-backend.ts'
import type { AgentContext, AgentStepRecord } from '@datasentry/backend/agent/backend.ts'
import type { ModelConfig } from '@datasentry/backend/agent/model-config.ts'

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'openai-compatible',
    name: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
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
    paramsSchema: {
      type: 'object',
      properties: { sourceSlug: { type: 'string' } },
      required: ['sourceSlug'],
      additionalProperties: false,
    },
    guideRead: true,
  },
  {
    name: 'mcp__erp__fetch_revenue',
    title: '查询收入',
    description: '按期间查询收入',
    paramsSchema: {
      type: 'object',
      properties: { period: { type: 'string' } },
      required: ['period'],
      additionalProperties: false,
    },
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
      body: '# 经营月报\n1. 先读 guide\n2. 再取数',
      requiredSources: ['erp', 'finance'],
      stopRules: ['数据齐了就停'],
    },
    tools: TOOLS,
    activeSourceSlugs: ['erp', 'finance'],
    history: [],
    ...overrides,
  }
}

function fakeFetch(response: { status?: number; body: unknown } | (() => Promise<never>)): {
  fetchImpl: FetchLike
  calls: Array<{ url: string; init: Parameters<FetchLike>[1] }>
} {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (typeof response === 'function') return response()
      const status = response.status ?? 200
      const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
      return { ok: status >= 200 && status < 300, status, text: async () => text }
    },
  }
}

function makeBackend(fake: ReturnType<typeof fakeFetch>): OpenAiCompatibleBackend {
  return new OpenAiCompatibleBackend({
    config: config(),
    apiKey: 'sk-test',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    fetchImpl: fake.fetchImpl,
  })
}

describe('OpenAI 兼容后端 · 请求构造', () => {
  it('打到 /chat/completions，用 Bearer 认证，工具按 function 格式带过去', async () => {
    const fake = fakeFetch({ body: { choices: [{ message: { content: '好' } }] } })
    await makeBackend(fake).nextAction(ctx())

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.url).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    )
    expect(fake.calls[0]!.init.headers['authorization']).toBe('Bearer sk-test')

    const body = JSON.parse(fake.calls[0]!.init.body) as Record<string, unknown>
    expect(body['model']).toBe('qwen-plus')
    expect(body['max_tokens']).toBe(16_000)
    expect(body['tool_choice']).toBe('auto')
    expect(body['stream']).toBe(false)

    const tools = body['tools'] as Array<{ type: string; function: { name: string; parameters: unknown } }>
    expect(tools.map((t) => t.type)).toEqual(['function', 'function'])
    expect(tools.map((t) => t.function.name)).toEqual([
      'datasentry__read_source_guide',
      'mcp__erp__fetch_revenue',
    ])
    expect(tools[1]!.function.parameters).toMatchObject({ type: 'object' })

    const messages = body['messages'] as Array<{ role: string }>
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]!.role).toBe('user')
  })

  it('baseUrl 末尾有斜杠也不会拼出双斜杠', async () => {
    const fake = fakeFetch({ body: { choices: [{ message: { content: '好' } }] } })
    await new OpenAiCompatibleBackend({
      config: config(),
      apiKey: 'k',
      baseUrl: 'https://example.com/v1/',
      fetchImpl: fake.fetchImpl,
    }).nextAction(ctx())

    expect(fake.calls[0]!.url).toBe('https://example.com/v1/chat/completions')
  })

  it('历史还原成 assistant.tool_calls + role:tool 成对出现', () => {
    const history: AgentStepRecord[] = [
      {
        step: 0,
        toolName: 'datasentry__read_source_guide',
        args: { sourceSlug: 'erp' },
        status: 'succeeded',
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
    ]

    const messages = buildMessages(ctx({ history }))
    // system + 任务 + 每步 2 条
    expect(messages).toHaveLength(2 + history.length * 2)

    for (let i = 0; i < history.length; i += 1) {
      const assistant = messages[2 + i * 2] as {
        role: string
        tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
      }
      const tool = messages[3 + i * 2] as { role: string; tool_call_id: string; content: string }

      expect(assistant.role).toBe('assistant')
      expect(assistant.tool_calls[0]!.type).toBe('function')
      expect(JSON.parse(assistant.tool_calls[0]!.function.arguments)).toEqual(history[i]!.args)

      expect(tool.role).toBe('tool')
      // 配对必须一致，否则 API 会拒绝
      expect(tool.tool_call_id).toBe(assistant.tool_calls[0]!.id)
    }

    const success = messages[5] as { content: string }
    expect(success.content).toContain('totalRevenue')
  })
})

describe('OpenAI 兼容后端 · 响应解析', () => {
  it('tool_calls 里的 arguments 是 JSON 字符串，要解析成对象', async () => {
    const fake = fakeFetch({
      body: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '先查收入',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'mcp__erp__fetch_revenue', arguments: '{"period":"2025-09"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    })

    const action = await makeBackend(fake).nextAction(ctx())
    expect(action).toMatchObject({
      type: 'tool_calls',
      calls: [{ name: 'mcp__erp__fetch_revenue', args: { period: '2025-09' } }],
      rationale: '先查收入',
    })
  })

  it('多个 tool_calls 一次返回', async () => {
    const fake = fakeFetch({
      body: {
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'a', function: { name: 'mcp__erp__fetch_revenue', arguments: '{"period":"2025-09"}' } },
                { id: 'b', function: { name: 'mcp__erp__fetch_cost', arguments: '{"period":"2025-09"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    })

    const action = await makeBackend(fake).nextAction(ctx())
    if (action.type !== 'tool_calls') throw new Error('应为 tool_calls')
    expect(action.calls).toHaveLength(2)
  })

  it('只有文本就结束', async () => {
    const fake = fakeFetch({
      body: {
        choices: [{ message: { content: '数据已取齐，报表已完成。' }, finish_reason: 'stop' }],
      },
    })

    expect(await makeBackend(fake).nextAction(ctx())).toEqual({
      type: 'finish',
      summary: '数据已取齐，报表已完成。',
    })
  })

  it('参数不是合法 JSON 时直接失败——绝不猜参数', async () => {
    const fake = fakeFetch({
      body: {
        choices: [
          {
            message: {
              tool_calls: [{ id: 'a', function: { name: 'mcp__erp__fetch_revenue', arguments: '{bad json' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    })

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

  it('内容过滤按拒答处理，不当成「说完了」', async () => {
    const fake = fakeFetch({
      body: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] },
    })

    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_REFUSED,
    })
  })

  it('输出被截断时报错，不返回半截动作', async () => {
    const fake = fakeFetch({
      body: { choices: [{ message: { content: '...' }, finish_reason: 'length' }] },
    })

    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('截断'),
    })
  })
})

describe('OpenAI 兼容后端 · 错误映射', () => {
  it('401 提示检查 key', async () => {
    const fake = fakeFetch({
      status: 401,
      body: { error: { message: 'Invalid API-key provided.' } },
    })

    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('认证失败'),
    })
  })

  it('429 提示限流', async () => {
    const fake = fakeFetch({ status: 429, body: { error: { message: 'rate limited' } } })
    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      message: expect.stringContaining('限流'),
    })
  })

  it('404 提示检查 baseUrl 与模型名', async () => {
    const fake = fakeFetch({ status: 404, body: { error: { message: 'model not found' } } })
    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      message: expect.stringContaining('baseUrl'),
    })
  })

  it('网络异常也包成 MODEL_CALL_FAILED，不裸奔', async () => {
    const fake = fakeFetch(() => Promise.reject(new Error('ECONNREFUSED')))
    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('ECONNREFUSED'),
    })
  })

  it('返回非 JSON 时带上原文片段', async () => {
    const fake = fakeFetch({ body: '<html>502 Bad Gateway</html>' })
    await expect(makeBackend(fake).nextAction(ctx())).rejects.toMatchObject({
      message: expect.stringContaining('不是 JSON'),
    })
  })
})
