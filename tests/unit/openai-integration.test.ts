import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { seedAll } from '@datasentry/mcp-sources'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

/**
 * 端到端验证「切到 OpenAI 兼容端点」这条链路真的通。
 *
 * 用本地假服务冒充千问的 `/chat/completions`：不联网、不花钱，
 * 但走的是**真实的 context 装配 + 真实的后端选择 + 真实的 Agent Loop**。
 * 单元测试覆盖后端内部逻辑，这一条补的是「它有没有被接上」。
 */

interface CapturedRequest {
  authorization: string | undefined
  body: Record<string, unknown>
}

let server: Server
let baseUrl: string
let captured: CapturedRequest[] = []
let temp: TempPaths
let ctx: AppContext

const savedEnv = new Map<string, string | undefined>()

function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      captured.push({ authorization: req.headers['authorization'], body })

      // 第一次让它去读 guide，第二次让它收工。
      const payload =
        captured.length === 1
          ? {
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'datasentry__read_source_guide',
                          arguments: JSON.stringify({ sourceSlug: 'erp' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            }
          : {
              choices: [
                { message: { role: 'assistant', content: '取数完成。' }, finish_reason: 'stop' },
              ],
              usage: { prompt_tokens: 200, completion_tokens: 10 },
            }

      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('假服务没有拿到端口')
  baseUrl = `http://127.0.0.1:${address.port}/v1`

  setEnv('DATASENTRY_MODEL_PROVIDER', 'openai-compatible')
  setEnv('DATASENTRY_MODEL_API_KEY', 'sk-test-key')
  setEnv('DATASENTRY_MODEL_BASE_URL', baseUrl)

  temp = tempPaths('datasentry-openai-e2e-')
  await seedAll(temp.paths)
  ctx = await createAppContext({ paths: temp.paths })
})

afterAll(async () => {
  await ctx?.close()
  temp?.cleanup()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('切到 OpenAI 兼容端点（千问）', () => {
  it('context 选中的是兼容后端，不是 Mock', () => {
    const described = ctx.model.describe()
    expect(described['provider']).toBe('openai-compatible')
    expect(described['name']).toBe('qwen-plus')
    expect(String(described['baseUrl'])).toContain('127.0.0.1')
  })

  it('一次真实会话会打到配置的端点，并按模型给的 tool_calls 执行工具', async () => {
    const session = ctx.createSession({
      workspace: 'group-finance',
      request: '出 2025 年 9 月的经营月报',
      input: {},
    })

    const outcome = await ctx.runSession(session.id)

    // 模型只让它读了 guide 就收工，数据不全 → 校验失败
    expect(outcome.state).toBe('FAILED')
    expect(outcome.errorCode).toBe('VALIDATION_FAILED')

    const events = ctx.events.readJsonl(session.id)
    const types = events.map((e) => e.type)

    // 关键：guide 是**模型要求读的**，然后被真实执行了
    expect(types).toContain('planning.completed')
    expect(types).toContain('tool.call.requested')
    expect(types).toContain('permission.decided')
    // 内置工具（读 guide）不产出取数结果，所以记的是 guide.read 而不是 tool.call.completed
    expect(types).toContain('guide.read')
    expect(types).toContain('validation.failed')

    // 请求确实打到了假端点上，且带了 Bearer 认证
    expect(captured.length).toBe(2)
    expect(captured[0]!.authorization).toBe('Bearer sk-test-key')
    expect(captured[0]!.body['model']).toBe('qwen-plus')

    // 第二轮请求里应当带上了工具执行结果（role: tool）
    const secondMessages = captured[1]!.body['messages'] as Array<{ role: string }>
    expect(secondMessages.some((m) => m.role === 'tool')).toBe(true)
  })
})
