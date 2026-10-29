import { z } from 'zod'

/** JSON Schema 对象（工具参数 / 结果契约都以它声明）。 */
export type JsonSchema = Record<string, unknown>

const compiled = new WeakMap<object, z.ZodType>()

/**
 * 把工具声明里的 JSON Schema 编译成 Zod 校验器。
 *
 * 之所以走 JSON Schema 而不是直接写 Zod：同一个契约既要被人写进 `config.json`，
 * 又要喂给 MCP 服务端（MCP 本身用 JSON Schema），还要在后端做参数校验。
 * 让它只有一个事实来源。
 */
export function compileJsonSchema(schema: JsonSchema): z.ZodType {
  const cached = compiled.get(schema)
  if (cached) return cached
  const validator = z.fromJSONSchema(schema as never)
  compiled.set(schema, validator)
  return validator
}

export interface ValidationOk<T = unknown> {
  ok: true
  data: T
}

export interface ValidationFail {
  ok: false
  /** 首个校验错误，供事件与错误码使用。 */
  message: string
  path: string
  issues: z.core.$ZodIssue[]
}

export type ValidationOutcome<T = unknown> = ValidationOk<T> | ValidationFail

export function validateWithJsonSchema<T = unknown>(
  schema: JsonSchema,
  value: unknown,
): ValidationOutcome<T> {
  let validator: z.ZodType
  try {
    validator = compileJsonSchema(schema)
  } catch (err) {
    return {
      ok: false,
      message: `参数契约本身不是合法 JSON Schema：${err instanceof Error ? err.message : String(err)}`,
      path: '',
      issues: [],
    }
  }

  const result = validator.safeParse(value)
  if (result.success) return { ok: true, data: result.data as T }

  const first = result.error.issues[0]
  return {
    ok: false,
    message: first ? `${first.path.join('.') || '<root>'}: ${first.message}` : '参数校验失败',
    path: first ? first.path.join('.') : '',
    issues: result.error.issues,
  }
}
