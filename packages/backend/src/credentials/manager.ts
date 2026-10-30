import { existsSync, readFileSync } from 'node:fs'
import {
  CREDENTIAL_ENV_PREFIX,
  credentialEnvVar,
  dataPaths,
  ErrorCode,
  fail,
  REDACTED,
  type DataPaths,
} from '@datasentry/core'

/**
 * 凭据管理（PRD FR-01.3 / §8 安全）。
 *
 * 设计要点：凭据只在**注入点**出现——spawn 子进程时的 env、发 HTTP 请求时的头。
 * 它不会进入模型上下文（工具描述里只有类型没有值），也不会进事件轨迹和报表产物
 * （`scrub` 会在落库/落盘前把出现过的凭据值替换掉）。
 *
 * 因此凭据不靠「约定别打印」，而靠一条明确的出口过滤。
 */
export class CredentialManager {
  private readonly values: Map<string, string>
  /** 用于文本扫描的凭据值，按长度降序，避免短值先匹配把长值切碎。 */
  private readonly secrets: string[]

  private constructor(values: Map<string, string>, secrets: readonly string[]) {
    this.values = values
    this.secrets = [...new Set(secrets)].sort((a, b) => b.length - a.length)
  }

  /**
   * 从 `data/credentials.json` 与环境变量加载。
   * 环境变量优先，便于 CI 与容器注入而不落盘。
   */
  static load(paths: DataPaths = dataPaths()): CredentialManager {
    const fileValues = new Map<string, string>()

    if (existsSync(paths.credentials)) {
      try {
        const parsed = JSON.parse(readFileSync(paths.credentials, 'utf8')) as Record<string, unknown>
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') fileValues.set(key, value)
        }
      } catch (err) {
        throw new Error(
          `${paths.credentials} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const values = new Map(fileValues)
    /** 覆盖文件凭据的环境变量值：它们替换的是已知密钥，仍按 4 字符下限清洗。 */
    const overrideSecrets: string[] = []
    /** 只有环境变量、没有文件条目的值：低熵短值不参与全文替换。 */
    const extraSecrets: string[] = []

    // 环境变量按 core 的命名约定精确反查，不做有损的字符串还原。
    for (const key of [...fileValues.keys()]) {
      const fromEnv = process.env[credentialEnvVar(key)]
      if (fromEnv !== undefined) {
        values.set(key, fromEnv)
        overrideSecrets.push(fromEnv)
      }
    }

    /*
     * 只有环境变量、没有进 credentials.json 的凭据也必须纳入清洗表。
     * 例如 `DATASENTRY_CRED_WECOM_BOARD_ROOM`：它由 `get()` 正常取出并注入，
     * 但如果只扫描文件里的键，`scrub()` 就永远不知道这个值，错误信息或
     * 工具返回里出现它时会被原样写进事件轨迹。
     *
     * Windows 的环境变量查找不区分大小写，前缀判断也要跟着不区分。
     */
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && name.toUpperCase().startsWith(CREDENTIAL_ENV_PREFIX)) {
        extraSecrets.push(value)
      }
    }

    /*
     * 文件里的凭据通常是我们自己生成的长串；环境变量可能是 `finance` 这类
     * 低熵值，全文替换会把报表正文里的普通单词也替换掉。env-only 用 8 字符
     * 作为下限；显式覆盖文件凭据的值则按 4 字符处理——它替换的是真实密钥。
     */
    const secrets = [
      ...[...fileValues.values()].filter((value) => value.length >= 4),
      ...overrideSecrets.filter((value) => value.length >= 4),
      ...extraSecrets.filter((value) => value.length >= 8),
    ]
    return new CredentialManager(values, secrets)
  }

  has(key: string): boolean {
    return this.values.has(key) || process.env[credentialEnvVar(key)] !== undefined
  }

  get(key: string): string | undefined {
    return this.values.get(key) ?? process.env[credentialEnvVar(key)]
  }

  /** 取不到就报错——静默用空字符串会让「凭据过期」变成难以定位的 401。 */
  require(key: string): string {
    const value = this.get(key)
    if (value === undefined) {
      fail(ErrorCode.CREDENTIAL_MISSING, `缺少凭据 "${key}"`, { credentialKey: key })
    }
    return value
  }

  /** 供 spawn / HTTP 头使用的环境变量映射，键名遵循 core 的命名约定。 */
  envFor(credentialKeys: readonly string[]): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of credentialKeys) {
      const value = this.get(key)
      if (value !== undefined) env[credentialEnvVar(key)] = value
    }
    return env
  }

  /** 把文本里出现过的凭据值替换掉。任何落盘/落库前的文本都应过一遍。 */
  scrub(text: string): string {
    let out = text
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.replaceAll(secret, REDACTED)
    }
    return out
  }

  /** 递归清洗任意结构（事件 payload、报表产物）。 */
  scrubValue<T>(value: T): T {
    if (typeof value === 'string') return this.scrub(value) as unknown as T
    if (Array.isArray(value)) return value.map((item) => this.scrubValue(item)) as unknown as T
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.scrubValue(v)
      }
      return out as unknown as T
    }
    return value
  }
}
