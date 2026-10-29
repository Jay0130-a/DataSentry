import { describe, expect, it } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { ErrorCode, isDataSentryError } from '@datasentry/core'
import {
  buildMessages,
  ClaudeAgentBackend,
  type ClaudeClientLike,
  type ClaudeResponse,
} from '@datasentry/backend/agent/claude-backend.ts'
import { buildSystemPrompt } from '@datasentry/backend/agent/prompt.ts'
import type { AgentContext, AgentStepRecord } from '@datasentry/backend/agent/backend.ts'
import type { ModelConfig } from '@datasentry/backend/agent/model-config.ts'

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'anthropic',
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

/** 记录请求体的假客户端，不联网。 */
function fakeClient(response: ClaudeResponse | (() => Promise<ClaudeResponse>)): {
  client: ClaudeClientLike
  calls: Record<string, unknown>[]
} {
  const calls: Record<string, unknown>[] = []
  return {
    calls,
    client: {
      messages: {
        async create(body) {
          calls.push(body)
          return typeof response === 'function' ? response() : response
        },
      },
    },
  }
}

describe('Claude 后端 · 请求构造', () => {
  it('第一次调用只发一条用户消息，工具按 JSON Schema 原样带过去', async () => {
    const fake = fakeClient({ content: [{ type: 'text', text: '好的' }] })
    await new ClaudeAgentBackend({ config: config(), client: fake.client }).nextAction(ctx())

    const body = fake.calls[0]!
    expect(body['model']).toBe('claude-opus-5-5')
    expect(body['max_tokens']).toBe(16_000)
    // 强制 tool_choice（any/tool）在 Opus 5.5 上会 400，必须用 auto
    expect(body['tool_choice']).toEqual({ type: 'auto' })

    const messages = body['messages'] as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(String(messages[0]!.content)).toContain('出 2025 年 9 月的经营月报')

    const tools = body['tools'] as Array<{ name: string; input_schema: Record<string, unknown> }>
    expect(tools.map((t) => t.name)).toEqual([
      'datasentry__read_source_guide',
      'mcp__erp__fetch_revenue',
    ])
    expect(tools[1]!.input_schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
  })

  it('支持 adaptive thinking 的模型才带 thinking 与 effort', async () => {
    const fake = fakeClient({ content: [{ type: 'text', text: '好' }] })
    await new ClaudeAgentBackend({
      config: config({ name: 'claude-opus-5-5', effort: 'high' }),
      client: fake.client,
    }).nextAction(ctx())

    expect(fake.calls[0]!['thinking']).toEqual({ type: 'adaptive' })
    expect(fake.calls[0]!['output_config']).toEqual({ effort: 'high' })
  })

  it('老模型不带 thinking —— 发过去会 400', async () => {
    const fake = fakeClient({ content: [{ type: 'text', text: '好' }] })
    await new ClaudeAgentBackend({
      config: config({ name: 'claude-haiku-4-5' }),
      client: fake.client,
    }).nextAction(ctx())

    expect(fake.calls[0]!['thinking']).toBeUndefined()
    expect(fake.calls[0]!['output_config']).toBeUndefined()
  })

  it('配置关闭思考时不发 thinking', async () => {
    const fake = fakeClient({ content: [{ type: 'text', text: '好' }] })
    await new ClaudeAgentBackend({
      config: config({ thinking: false }),
      client: fake.client,
    }).nextAction(ctx())

    expect(fake.calls[0]!['thinking']).toBeUndefined()
  })

  it('历史被还原成 assistant 的 tool_use + user 的 tool_result 成对出现', () => {
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
      {
        step: 2,
        toolName: 'mcp__finance__fetch_expense_detail',
        args: { period: '2025-09' },
        status: 'denied',
        errorCode: 'APPROVAL_REQUIRED',
        errorMessage: '需要审批',
      },
    ]

    const messages = buildMessages(ctx({ history }))
    // 1 条任务 + 每步 2 条
    expect(messages).toHaveLength(1 + history.length * 2)

    for (let i = 0; i < history.length; i += 1) {
      const assistant = messages[1 + i * 2] as { role: string; content: Array<Record<string, unknown>> }
      const user = messages[2 + i * 2] as { role: string; content: Array<Record<string, unknown>> }
      expect(assistant.role).toBe('assistant')
      expect(assistant.content[0]!['type']).toBe('tool_use')
      expect(user.role).toBe('user')
      expect(user.content[0]!['type']).toBe('tool_result')
      // 配对必须一致，否则 API 会拒绝
      expect(user.content[0]!['tool_use_id']).toBe(assistant.content[0]!['id'])
    }

    // 成功的结果带数据与完整性，失败的结果标记 is_error
    // 布局：0=任务，1/2=第 0 步，3/4=第 1 步，5/6=第 2 步
    const success = messages[4] as { content: Array<Record<string, unknown>> }
    expect(String(success.content[0]!['content'])).toContain('totalRevenue')
    expect(success.content[0]!['is_error']).toBe(false)

    const denied = messages[6] as { content: Array<Record<string, unknown>> }
    expect(denied.content[0]!['is_error']).toBe(true)
    expect(String(denied.content[0]!['content'])).toContain('需要审批')
  })

  it('系统提示词把「先读 guide、只能用这些 Source」写清楚', () => {
    const prompt = buildSystemPrompt(ctx())
    expect(prompt).toContain('monthly-operation-report')
    expect(prompt).toContain('datasentry__read_source_guide')
    expect(prompt).toContain('erp、finance')
    expect(prompt).toContain('已完成 0 步')
  })
})

describe('Claude 后端 · 响应解析', () => {
  it('有 tool_use 就转成工具调用', async () => {
    const fake = fakeClient({
      content: [
        { type: 'text', text: '先查一下事业部' },
        { type: 'tool_use', id: 'toolu_1', name: 'mcp__erp__fetch_revenue', input: { period: '2025-09' } },
      ],
      stop_reason: 'tool_use',
    })

    const action = await new ClaudeAgentBackend({ config: config(), client: fake.client }).nextAction(ctx())

    expect(action).toMatchObject({
      type: 'tool_calls',
      calls: [{ name: 'mcp__erp__fetch_revenue', args: { period: '2025-09' } }],
      rationale: '先查一下事业部',
    })
  })

  it('多个 tool_use 一次返回', async () => {
    const fake = fakeClient({
      content: [
        { type: 'tool_use', id: 'a', name: 'mcp__erp__fetch_revenue', input: { period: '2025-09' } },
        { type: 'tool_use', id: 'b', name: 'mcp__erp__fetch_cost', input: { period: '2025-09' } },
      ],
      stop_reason: 'tool_use',
    })

    const action = await new ClaudeAgentBackend({ config: config(), client: fake.client }).nextAction(ctx())
    expect(action.type).toBe('tool_calls')
    if (action.type === 'tool_calls') expect(action.calls).toHaveLength(2)
  })

  it('只有文本就结束', async () => {
    const fake = fakeClient({
      content: [{ type: 'text', text: '数据已取齐，报表已完成。' }],
      stop_reason: 'end_turn',
    })

    const action = await new ClaudeAgentBackend({ config: config(), client: fake.client }).nextAction(ctx())
    expect(action).toEqual({ type: 'finish', summary: '数据已取齐，报表已完成。' })
  })

  it('拒答不能被当成「说完了」', async () => {
    const fake = fakeClient({
      content: [],
      stop_reason: 'refusal',
      stop_details: { category: 'cyber', explanation: 'policy' },
    })

    const backend = new ClaudeAgentBackend({ config: config(), client: fake.client })
    try {
      await backend.nextAction(ctx())
      throw new Error('本应抛出 MODEL_REFUSED')
    } catch (err) {
      expect(isDataSentryError(err)).toBe(true)
      if (isDataSentryError(err)) {
        expect(err.code).toBe(ErrorCode.MODEL_REFUSED)
        expect(err.message).toContain('cyber')
      }
    }
  })

  it('输出被 max_tokens 截断时报错，而不是返回半截动作', async () => {
    const fake = fakeClient({ content: [], stop_reason: 'max_tokens' })
    const backend = new ClaudeAgentBackend({ config: config(), client: fake.client })

    try {
      await backend.nextAction(ctx())
      throw new Error('本应抛出 MODEL_CALL_FAILED')
    } catch (err) {
      if (isDataSentryError(err)) expect(err.code).toBe(ErrorCode.MODEL_CALL_FAILED)
      else throw err
    }
  })
})

describe('Claude 后端 · 错误映射', () => {
  it('认证失败给出可操作的提示', async () => {
    const error = Object.create(Anthropic.AuthenticationError.prototype) as Error
    error.message = 'invalid x-api-key'

    const backend = new ClaudeAgentBackend({
      config: config(),
      client: fakeClient(() => Promise.reject(error)).client,
    })

    await expect(backend.nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('认证失败'),
    })
  })

  it('限流单独说明', async () => {
    const error = Object.create(Anthropic.RateLimitError.prototype) as Error
    error.message = 'slow down'

    const backend = new ClaudeAgentBackend({
      config: config(),
      client: fakeClient(() => Promise.reject(error)).client,
    })

    await expect(backend.nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('限流'),
    })
  })

  it('普通异常也包成 MODEL_CALL_FAILED，不裸奔', async () => {
    const backend = new ClaudeAgentBackend({
      config: config(),
      client: fakeClient(() => Promise.reject(new Error('socket hang up'))).client,
    })

    await expect(backend.nextAction(ctx())).rejects.toMatchObject({
      code: ErrorCode.MODEL_CALL_FAILED,
      message: expect.stringContaining('socket hang up'),
    })
  })
})
