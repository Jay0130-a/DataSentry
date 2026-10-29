import { existsSync, readFileSync } from 'node:fs'
import { credentialEnvVar, dataPaths, ErrorCode, fail, REDACTED, type DataPaths } from '@datasentry/core'

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

  private constructor(values: Map<string, string>) {
    this.values = values
    this.secrets = [...values.values()].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)
  }

  /**
   * 从 `data/credentials.json` 与环境变量加载。
   * 环境变量优先，便于 CI 与容器注入而不落盘。
   */
  static load(paths: DataPaths = dataPaths()): CredentialManager {
    const values = new Map<string, string>()

    if (existsSync(paths.credentials)) {
      try {
        const parsed = JSON.parse(readFileSync(paths.credentials, 'utf8')) as Record<string, unknown>
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') values.set(key, value)
        }
      } catch (err) {
        throw new Error(
          `${paths.credentials} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    // 环境变量按 core 的命名约定精确反查，不做有损的字符串还原。
    for (const key of [...values.keys()]) {
      const fromEnv = process.env[credentialEnvVar(key)]
      if (fromEnv !== undefined) values.set(key, fromEnv)
    }

    return new CredentialManager(values)
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
