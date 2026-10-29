/**
 * 最小 Cookie 读写。
 *
 * 只为了一个 httpOnly 登录 Cookie，不值得引 `@fastify/cookie`：
 * 需要的语法就两条——`name=value; attr` 和从请求头里取某个名字。
 */

export interface CookieOptions {
  path?: string
  maxAgeSeconds?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null

  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return null
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const segments = [`${name}=${encodeURIComponent(value)}`]
  segments.push(`Path=${options.path ?? '/'}`)
  if (options.maxAgeSeconds !== undefined) segments.push(`Max-Age=${Math.max(0, options.maxAgeSeconds)}`)
  if (options.httpOnly !== false) segments.push('HttpOnly')
  if (options.secure) segments.push('Secure')
  if (options.sameSite) segments.push(`SameSite=${options.sameSite}`)
  return segments.join('; ')
}
