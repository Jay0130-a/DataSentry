import { createHash } from 'node:crypto'

/**
 * 稳定序列化：对象键递归排序、丢弃 undefined、拒绝 NaN/Infinity。
 *
 * 这是审批绑定与回归比对的正确性基础——同一个逻辑参数在任何进程、
 * 任何键插入顺序下都必须得到同一个字符串，否则审批会莫名失效。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null) return null

  switch (typeof value) {
    case 'undefined':
      return undefined
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: 不支持非有限数值 ${String(value)}`)
      }
      return value
    case 'bigint':
      return value.toString()
    case 'boolean':
    case 'string':
      return value
    case 'function':
    case 'symbol':
      throw new TypeError(`canonicalJson: 不支持的类型 ${typeof value}`)
  }

  const obj = value as object
  if (seen.has(obj)) throw new TypeError('canonicalJson: 检测到循环引用')
  seen.add(obj)
  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => canonicalize(item, seen) ?? null)
    }
    if (obj instanceof Date) return obj.toISOString()
    if (obj instanceof Map) {
      return canonicalize(Object.fromEntries(obj), seen)
    }
    if (obj instanceof Set) {
      return canonicalize([...obj], seen)
    }

    const source = obj as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const item = canonicalize(source[key], seen)
      if (item !== undefined) out[key] = item
    }
    return out
  } finally {
    seen.delete(obj)
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 对任意值取稳定摘要，用于 params_hash / recipients_hash / 内容版本号。 */
export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value))
}

/** 取摘要前 16 位，用于日志与产物中的短标识。 */
export function shortHash(value: unknown): string {
  return hashValue(value).slice(0, 16)
}
