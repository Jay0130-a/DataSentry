import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataPaths } from '@datasentry/core'
import {
  describeModelConfig,
  loadModelConfig,
  ModelProvider,
  resolveModelCredentials,
  supportsAdaptiveThinking,
  supportsEffort,
} from '@datasentry/backend/agent/model-config.ts'

const ENV_KEYS = [
  'DATASENTRY_MODEL_PROVIDER',
  'DATASENTRY_MODEL_NAME',
  'DATASENTRY_MODEL_MAX_TOKENS',
  'DATASENTRY_MODEL_EFFORT',
  'DATASENTRY_MODEL_THINKING',
  'DATASENTRY_MODEL_API_KEY',
  'DATASENTRY_MODEL_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
] as const

const saved = new Map<string, string | undefined>()

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    delete process.env[key]
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
}

/** 一个只含配置文件、不含环境变量的临时仓库根。 */
function tempRoot(config?: unknown): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'datasentry-model-'))
  if (config !== undefined) {
    writeFileSync(join(root, 'datasentry.config.json'), JSON.stringify(config), 'utf8')
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

afterEach(() => {
  restoreEnv()
})

describe('模型配置解析', () => {
  it('没有配置文件时默认是 mock —— 不花钱、不依赖网络', () => {
    clearEnv()
    const temp = tempRoot()
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(config.provider).toBe(ModelProvider.MOCK)
      expect(config.name).toBe('claude-opus-5-5')
    } finally {
      temp.cleanup()
    }
  })

  it('读取配置文件里的设置', () => {
    clearEnv()
    const temp = tempRoot({
      model: { provider: 'anthropic', name: 'claude-sonnet-5-5', maxTokens: 8000 },
    })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(config.provider).toBe('anthropic')
      expect(config.name).toBe('claude-sonnet-5-5')
      expect(config.maxTokens).toBe(8000)
      // 未写的字段回落到默认
      expect(config.effort).toBe('high')
    } finally {
      temp.cleanup()
    }
  })

  it('环境变量覆盖配置文件', () => {
    clearEnv()
    const temp = tempRoot({ model: { provider: 'mock', name: 'claude-opus-5-5' } })
    process.env['DATASENTRY_MODEL_PROVIDER'] = 'anthropic'
    process.env['DATASENTRY_MODEL_NAME'] = 'claude-haiku-5-5'
    process.env['DATASENTRY_MODEL_EFFORT'] = 'low'
    process.env['DATASENTRY_MODEL_THINKING'] = 'false'

    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(config.provider).toBe('anthropic')
      expect(config.name).toBe('claude-haiku-5-5')
      expect(config.effort).toBe('low')
      expect(config.thinking).toBe(false)
    } finally {
      temp.cleanup()
    }
  })

  it('provider 写错时立刻报错，而不是等到调用模型', () => {
    clearEnv()
    const temp = tempRoot()
    process.env['DATASENTRY_MODEL_PROVIDER'] = 'openai-ish'
    try {
      expect(() => loadModelConfig(dataPaths({ root: temp.root }))).toThrowError(
        /DATASENTRY_MODEL_PROVIDER/,
      )
    } finally {
      temp.cleanup()
    }
  })

  it('maxTokens 超范围时报错', () => {
    clearEnv()
    const temp = tempRoot()
    process.env['DATASENTRY_MODEL_MAX_TOKENS'] = '10'
    try {
      expect(() => loadModelConfig(dataPaths({ root: temp.root }))).toThrowError(/DATASENTRY_MODEL_MAX_TOKENS/)
    } finally {
      temp.cleanup()
    }
  })

  it('配置文件不是合法 JSON 时报错并指出路径', () => {
    clearEnv()
    const root = mkdtempSync(join(tmpdir(), 'datasentry-model-'))
    writeFileSync(join(root, 'datasentry.config.json'), '{ 坏掉的 json', 'utf8')
    try {
      expect(() => loadModelConfig(dataPaths({ root }))).toThrowError(/不是合法 JSON/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('凭据解析', () => {
  it('优先用应用自己的变量', () => {
    clearEnv()
    process.env['DATASENTRY_MODEL_API_KEY'] = 'app-key'
    process.env['ANTHROPIC_API_KEY'] = 'ambient-key'
    const config = loadModelConfig(dataPaths({ root: tempRoot().root }))

    expect(resolveModelCredentials(config)).toMatchObject({
      apiKey: 'app-key',
      source: 'DATASENTRY_MODEL_API_KEY',
    })
  })

  it('没有应用变量时回落到该 provider 的通用变量', () => {
    clearEnv()
    process.env['ANTHROPIC_API_KEY'] = 'ambient-key'
    const temp = tempRoot({ model: { provider: 'anthropic' } })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(resolveModelCredentials(config)).toMatchObject({
        apiKey: 'ambient-key',
        source: 'ANTHROPIC_API_KEY',
      })
    } finally {
      temp.cleanup()
    }
  })

  it('都没有时返回 null，由调用方决定怎么报错', () => {
    clearEnv()
    const config = loadModelConfig(dataPaths({ root: tempRoot().root }))
    expect(resolveModelCredentials(config)).toEqual({ apiKey: null, baseUrl: null, source: null })
  })

  it('自定义 apiKeyEnv 也能被识别', () => {
    clearEnv()
    process.env['MY_CORP_KEY'] = 'corp-key'
    const config = { ...loadModelConfig(dataPaths({ root: tempRoot().root })), apiKeyEnv: 'MY_CORP_KEY' }
    try {
      expect(resolveModelCredentials(config)).toMatchObject({ apiKey: 'corp-key', source: 'MY_CORP_KEY' })
    } finally {
      delete process.env['MY_CORP_KEY']
    }
  })

  it('用自己的 key 时不会继承别家工具的 ANTHROPIC_BASE_URL', () => {
    // 开发机上常常同时装着别的工具，它们的 ANTHROPIC_BASE_URL 不该被悄悄继承，
    // 否则就成了「用我的 key，打到别人的代理上」。
    clearEnv()
    process.env['DATASENTRY_MODEL_API_KEY'] = 'my-own-key'
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:15721'

    const config = loadModelConfig(dataPaths({ root: tempRoot().root }))
    expect(resolveModelCredentials(config)).toMatchObject({
      apiKey: 'my-own-key',
      source: 'DATASENTRY_MODEL_API_KEY',
      baseUrl: null,
    })
  })

  it('用 ambient key 时才连带继承 ambient base URL', () => {
    clearEnv()
    process.env['ANTHROPIC_API_KEY'] = 'ambient-key'
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:15721'

    const temp = tempRoot({ model: { provider: 'anthropic' } })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(resolveModelCredentials(config)).toMatchObject({
        source: 'ANTHROPIC_API_KEY',
        baseUrl: 'http://127.0.0.1:15721',
      })
    } finally {
      temp.cleanup()
    }
  })

  it('显式指定 base URL 时总是优先', () => {
    clearEnv()
    process.env['DATASENTRY_MODEL_API_KEY'] = 'my-own-key'
    process.env['DATASENTRY_MODEL_BASE_URL'] = 'https://my-gateway.example.com'
    process.env['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:15721'

    const config = loadModelConfig(dataPaths({ root: tempRoot().root }))
    expect(resolveModelCredentials(config).baseUrl).toBe('https://my-gateway.example.com')
  })
})

describe('安全摘要', () => {
  it('永远不返回密钥本身', () => {
    clearEnv()
    process.env['DATASENTRY_MODEL_API_KEY'] = 'sk-super-secret-value'
    const config = { ...loadModelConfig(dataPaths({ root: tempRoot().root })), provider: ModelProvider.ANTHROPIC }

    const described = describeModelConfig(config)
    const text = JSON.stringify(described)

    expect(text).not.toContain('sk-super-secret-value')
    expect(described['credentials']).toMatchObject({ present: true, source: 'DATASENTRY_MODEL_API_KEY' })
  })
})

describe('模型能力判定', () => {
  it('新模型支持 adaptive thinking 与 effort', () => {
    for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-7']) {
      expect(supportsAdaptiveThinking(model), model).toBe(true)
      expect(supportsEffort(model), model).toBe(true)
    }
  })

  it('老模型不发 adaptive thinking —— 发过去会 400', () => {
    for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5']) {
      expect(supportsAdaptiveThinking(model), model).toBe(false)
      expect(supportsEffort(model), model).toBe(false)
    }
  })
})

describe('OpenAI 兼容端点（千问）', () => {
  it('只改 provider 就能拿到千问的默认模型与端点', () => {
    clearEnv()
    const temp = tempRoot({ model: { provider: 'openai-compatible' } })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(config.name).toBe('qwen-plus')
      expect(config.baseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    } finally {
      temp.cleanup()
    }
  })

  it('显式写的模型名与端点优先于默认值', () => {
    clearEnv()
    const temp = tempRoot({
      model: {
        provider: 'openai-compatible',
        name: 'qwen-max',
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      },
    })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(config.name).toBe('qwen-max')
      expect(config.baseUrl).toContain('dashscope-intl')
    } finally {
      temp.cleanup()
    }
  })

  it('baseUrl 写成 null 等价于「没设」，用 provider 默认端点', () => {
    // 配置模板里默认就写着 `baseUrl: null`；如果把它当成「明确要求没有端点」，
    // 切到 openai-compatible 时就会莫名其妙地报错。
    clearEnv()
    const temp = tempRoot({ model: { provider: 'openai-compatible', baseUrl: null } })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(config.baseUrl).toContain('dashscope')
    } finally {
      temp.cleanup()
    }
  })

  it('密钥可以回落到 DASHSCOPE_API_KEY', () => {
    clearEnv()
    process.env['DASHSCOPE_API_KEY'] = 'dashscope-key'
    const temp = tempRoot({ model: { provider: 'openai-compatible' } })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      expect(resolveModelCredentials(config)).toMatchObject({
        apiKey: 'dashscope-key',
        source: 'DASHSCOPE_API_KEY',
      })
    } finally {
      temp.cleanup()
    }
  })

  it('不会把 thinking/effort 报成适用——那是 Anthropic 专有的', () => {
    clearEnv()
    const temp = tempRoot({ model: { provider: 'openai-compatible' } })
    try {
      const config = loadModelConfig(dataPaths({ root: temp.root }))
      const described = describeModelConfig(config, { apiKey: 'k', baseUrl: config.baseUrl, source: 'x' })
      expect(described['thinking']).toBeNull()
      expect(described['effort']).toBeNull()
      expect(described['baseUrl']).toContain('dashscope')
    } finally {
      temp.cleanup()
    }
  })
})
