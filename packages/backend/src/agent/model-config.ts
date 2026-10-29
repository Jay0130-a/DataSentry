import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { dataPaths, ErrorCode, fail, type DataPaths } from '@datasentry/core'

/**
 * 模型配置。
 *
 * 三条原则：
 *
 * 1. **默认是 Mock。** 没有显式配置就用确定性规划器，跑测试、跑回归、
 *    跑演示都不花钱，也不依赖网络。
 * 2. **密钥不落配置文件。** 配置里只写「去哪个环境变量取」，值留在环境里——
 *    和 Source 凭据是同一条规矩。
 * 3. **配置错了在启动时报错**，不要等到第一次调用模型才发现拼错了一个 provider 名。
 */

export const ModelProvider = {
  MOCK: 'mock',
  ANTHROPIC: 'anthropic',
  /** OpenAI 兼容协议：千问（DashScope）、DeepSeek、Moonshot、vLLM、Ollama 等。 */
  OPENAI_COMPATIBLE: 'openai-compatible',
  /**
   * pi-ai 的统一 provider 层。
   *
   * 一个后端覆盖它目录里的 42 个 provider（anthropic / openai / deepseek /
   * moonshotai / minimax / qwen-token-plan …）。具体用哪个由 `piProvider` 指定。
   */
  PI: 'pi',
} as const

export type ModelProvider = (typeof ModelProvider)[keyof typeof ModelProvider]

export const EffortLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  XHIGH: 'xhigh',
  MAX: 'max',
} as const

export type EffortLevel = (typeof EffortLevel)[keyof typeof EffortLevel]

const modelConfigSchema = z.object({
  provider: z.enum(ModelProvider),
  /** 模型 ID，例如 `claude-opus-5-5` 或 `qwen-plus`。 */
  name: z.string().min(1),
  /**
   * 端点地址。Anthropic 留空用官方默认；OpenAI 兼容端点必填。
   * 支持 `DATASENTRY_MODEL_BASE_URL` 覆盖。
   */
  baseUrl: z.string().nullable().default(null),
  /** 密钥所在的**环境变量名**，不是密钥本身。 */
  apiKeyEnv: z.string().min(1).default('DATASENTRY_MODEL_API_KEY'),
  /** 端点地址所在的**环境变量名**。 */
  baseUrlEnv: z.string().min(1).default('DATASENTRY_MODEL_BASE_URL'),
  maxTokens: z.number().int().min(256).max(128_000).default(16_000),
  /** 思考深度。仅 Anthropic 的当前模型支持。 */
  effort: z.enum(EffortLevel).default(EffortLevel.HIGH),
  /** 是否启用自适应思考。仅 Anthropic 的当前模型支持。 */
  thinking: z.boolean().default(true),
  /**
   * 仅 `provider: "pi"` 使用：pi 的 provider id，例如 `anthropic` / `openai` /
   * `deepseek` / `moonshotai` / `qwen-token-plan`。`name` 是它目录里的模型 id。
   */
  piProvider: z.string().min(1).default('anthropic'),
})

/**
 * 配置文件里允许写的字段——全部可选。
 *
 * 不能直接对输出 schema 用 `.partial()`：那样内层对象仍会套用默认值，
 * 而缺 `name` 时会被判成必填缺失，用户就没法「只写 provider」了。
 * 输入与输出两个 schema 分开，是为了让「没写」和「写了默认值」可区分。
 */
const modelConfigFileSchema = z
  .object({
    provider: z.enum(ModelProvider).optional(),
    name: z.string().min(1).optional(),
    baseUrl: z.string().nullable().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    baseUrlEnv: z.string().min(1).optional(),
    maxTokens: z.number().int().min(256).max(128_000).optional(),
    effort: z.enum(EffortLevel).optional(),
    thinking: z.boolean().optional(),
    piProvider: z.string().min(1).optional(),
  })
  .strict()

const appConfigFileSchema = z.object({ model: modelConfigFileSchema.optional() }).strict()

export type ModelConfigFile = z.infer<typeof modelConfigFileSchema>

/** 合并后的最终配置。 */
export const appConfigSchema = z.object({
  model: modelConfigSchema,
})

export type ModelConfig = z.infer<typeof modelConfigSchema>
export type AppConfig = z.infer<typeof appConfigSchema>

/**
 * 每个 provider 的默认模型与端点。
 *
 * 这些默认值的意义：切换 provider 时只需要改 `provider` 一个字段，
 * 不用同时记住「千问该填哪个 baseUrl」。用户显式写的值仍然优先。
 */
const PROVIDER_DEFAULTS: Record<ModelProvider, { name: string; baseUrl: string | null }> = {
  [ModelProvider.MOCK]: { name: 'claude-opus-5-5', baseUrl: null },
  [ModelProvider.ANTHROPIC]: { name: 'claude-opus-5-5', baseUrl: null },
  [ModelProvider.OPENAI_COMPATIBLE]: {
    // 千问的 OpenAI 兼容端点。国际站是 dashscope-intl.aliyuncs.com。
    name: 'qwen-plus',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  // pi 的端点与模型元数据来自它自己的目录，这里不写死；
  // baseUrl 只在需要覆盖时才填。
  [ModelProvider.PI]: { name: 'claude-opus-5-5', baseUrl: null },
}

/** 各 provider 可以回落的通用密钥变量。 */
const FALLBACK_KEY_ENVS: Record<ModelProvider, readonly string[]> = {
  [ModelProvider.MOCK]: [],
  [ModelProvider.ANTHROPIC]: ['ANTHROPIC_API_KEY'],
  [ModelProvider.OPENAI_COMPATIBLE]: ['DASHSCOPE_API_KEY', 'OPENAI_API_KEY'],
  // pi 的背后可能是任意一家，不做猜测——用 DATASENTRY_MODEL_API_KEY 显式给。
  [ModelProvider.PI]: [],
}

const COMMON_DEFAULTS: Omit<ModelConfig, 'provider' | 'name' | 'baseUrl'> = {
  apiKeyEnv: 'DATASENTRY_MODEL_API_KEY',
  baseUrlEnv: 'DATASENTRY_MODEL_BASE_URL',
  maxTokens: 16_000,
  effort: EffortLevel.HIGH,
  thinking: true,
  piProvider: 'anthropic',
}

export function configPath(paths: DataPaths = dataPaths()): string {
  return join(paths.root, 'datasentry.config.json')
}

function readConfigFile(paths: DataPaths): { model?: ModelConfigFile } {
  const file = configPath(paths)
  if (!existsSync(file)) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    fail(
      ErrorCode.MODEL_CONFIG_INVALID,
      `${file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const result = appConfigFileSchema.safeParse(parsed)
  if (!result.success) {
    const first = result.error.issues[0]
    fail(
      ErrorCode.MODEL_CONFIG_INVALID,
      `${file} 不符合配置契约：${first ? `${first.path.join('.')} — ${first.message}` : '未知错误'}`,
    )
  }
  return result.data
}

function envFlag(name: string): boolean | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  fail(ErrorCode.MODEL_CONFIG_INVALID, `${name} 必须是 true/false，收到 "${value}"`)
}

function envProvider(): ModelProvider | undefined {
  const raw = process.env['DATASENTRY_MODEL_PROVIDER']
  if (raw === undefined) return undefined
  const parsed = z.enum(ModelProvider).safeParse(raw)
  if (!parsed.success) {
    fail(
      ErrorCode.MODEL_CONFIG_INVALID,
      `DATASENTRY_MODEL_PROVIDER 必须是 ${Object.values(ModelProvider).join(' / ')}，收到 "${raw}"`,
    )
  }
  return parsed.data
}

/**
 * 解析最终生效的模型配置。
 *
 * 合并顺序：通用默认 → provider 默认（模型名/端点） → 配置文件 → 环境变量。
 * 环境变量最后是为了让 CI / 容器能覆盖而不用改文件。
 */
export function loadModelConfig(paths: DataPaths = dataPaths()): ModelConfig {
  const fileModel = readConfigFile(paths).model ?? {}
  const provider = envProvider() ?? fileModel.provider ?? ModelProvider.MOCK

  const merged: ModelConfig = {
    provider,
    // 「没写」才用 provider 默认值。
    name: fileModel.name ?? PROVIDER_DEFAULTS[provider].name,
    // `null` 与「没写」等价：配置模板里默认就写着 `baseUrl: null`，
    // 若把它当成「用户明确要求没有端点」，切到 openai-compatible 就会直接报错。
    // 何况这个字段本来就没有「显式留空」的语义——兼容端点必须有地址。
    baseUrl: fileModel.baseUrl ?? PROVIDER_DEFAULTS[provider].baseUrl,
    apiKeyEnv: fileModel.apiKeyEnv ?? COMMON_DEFAULTS.apiKeyEnv,
    baseUrlEnv: fileModel.baseUrlEnv ?? COMMON_DEFAULTS.baseUrlEnv,
    maxTokens: fileModel.maxTokens ?? COMMON_DEFAULTS.maxTokens,
    effort: fileModel.effort ?? COMMON_DEFAULTS.effort,
    thinking: fileModel.thinking ?? COMMON_DEFAULTS.thinking,
    piProvider: fileModel.piProvider ?? COMMON_DEFAULTS.piProvider,
  }

  const name = process.env['DATASENTRY_MODEL_NAME']
  if (name) merged.name = name

  const piProvider = process.env['DATASENTRY_PI_PROVIDER']
  if (piProvider) merged.piProvider = piProvider

  const baseUrl = process.env['DATASENTRY_MODEL_BASE_URL']
  if (baseUrl) merged.baseUrl = baseUrl

  const maxTokens = process.env['DATASENTRY_MODEL_MAX_TOKENS']
  if (maxTokens !== undefined) {
    const value = Number(maxTokens)
    if (!Number.isInteger(value) || value < 256 || value > 128_000) {
      fail(
        ErrorCode.MODEL_CONFIG_INVALID,
        `DATASENTRY_MODEL_MAX_TOKENS 必须是 256-128000 的整数，收到 "${maxTokens}"`,
      )
    }
    merged.maxTokens = value
  }

  const effort = process.env['DATASENTRY_MODEL_EFFORT']
  if (effort !== undefined) {
    const parsed = z.enum(EffortLevel).safeParse(effort)
    if (!parsed.success) {
      fail(
        ErrorCode.MODEL_CONFIG_INVALID,
        `DATASENTRY_MODEL_EFFORT 必须是 ${Object.values(EffortLevel).join(' / ')}，收到 "${effort}"`,
      )
    }
    merged.effort = parsed.data
  }

  const thinking = envFlag('DATASENTRY_MODEL_THINKING')
  if (thinking !== undefined) merged.thinking = thinking

  // OpenAI 兼容端点没有默认地址，必须有一个。
  if (merged.provider === ModelProvider.OPENAI_COMPATIBLE && !merged.baseUrl) {
    fail(
      ErrorCode.MODEL_CONFIG_INVALID,
      'provider 为 openai-compatible 时必须配置 baseUrl（或在 DATASENTRY_MODEL_BASE_URL 里给）',
      { model: merged.name },
    )
  }

  return merged
}

/**
 * 取模型调用所需的凭据。
 *
 * 顺序：应用自己的变量 → 配置里指定的变量 → 该 provider 的通用变量。
 *
 * **base URL 与 key 成对解析**：只有当 key 来自 `ANTHROPIC_API_KEY` 时，
 * 才回落到 `ANTHROPIC_BASE_URL`。否则会出现「用我的 key，却打到别人的代理上」——
 * 开发机上常常同时装着别的工具，它们的环境变量不该被悄悄继承。
 */
export function resolveModelCredentials(config: ModelConfig): {
  apiKey: string | null
  baseUrl: string | null
  source: string | null
} {
  const candidates = [
    'DATASENTRY_MODEL_API_KEY',
    config.apiKeyEnv,
    ...FALLBACK_KEY_ENVS[config.provider],
  ]

  for (const name of [...new Set(candidates)]) {
    const value = process.env[name]
    if (!value) continue

    const baseUrl =
      process.env['DATASENTRY_MODEL_BASE_URL'] ??
      process.env[config.baseUrlEnv] ??
      config.baseUrl ??
      (name === 'ANTHROPIC_API_KEY' ? (process.env['ANTHROPIC_BASE_URL'] ?? null) : null)

    return { apiKey: value, baseUrl, source: name }
  }

  return { apiKey: null, baseUrl: config.baseUrl ?? null, source: null }
}

/**
 * 模型能力判定。
 *
 * 不同代际的模型对 `thinking` 与 `output_config.effort` 的支持不一样：
 * 给不支持 adaptive 的模型发 `thinking: {type:"adaptive"}` 会直接 400。
 * 这里按型号前缀判断，宁可少发一个参数，也不要发一个会报错的参数。
 */
export function supportsAdaptiveThinking(model: string): boolean {
  return /claude-(fable-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/.test(model)
}

export function supportsEffort(model: string): boolean {
  return supportsAdaptiveThinking(model)
}

/** 给 CLI / API 展示用的安全摘要——永远不返回密钥本身。 */
export function describeModelConfig(
  config: ModelConfig,
  credentials: ReturnType<typeof resolveModelCredentials> = resolveModelCredentials(config),
): Record<string, unknown> {
  return {
    provider: config.provider,
    name: config.name,
    ...(config.provider === ModelProvider.PI ? { piProvider: config.piProvider } : {}),
    baseUrl: credentials.baseUrl,
    maxTokens: config.maxTokens,
    // thinking / effort 只对 Anthropic 有意义，对兼容端点直接标不适用
    effort: config.provider === ModelProvider.ANTHROPIC ? config.effort : null,
    thinking: config.provider === ModelProvider.ANTHROPIC ? config.thinking : null,
    adaptiveThinking:
      config.provider === ModelProvider.ANTHROPIC
        ? supportsAdaptiveThinking(config.name)
        : null,
    effortSupported:
      config.provider === ModelProvider.ANTHROPIC ? supportsEffort(config.name) : null,
    credentials: {
      present: credentials.apiKey !== null,
      source: credentials.source,
      baseUrl: credentials.baseUrl,
    },
  }
}

export { PROVIDER_DEFAULTS, FALLBACK_KEY_ENVS }
