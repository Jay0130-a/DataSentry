import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ErrorCode, fail } from '@datasentry/core'
import type { AuthUser } from '../auth/service.ts'
import type { AppContext } from '../context.ts'
import { readCookie } from './cookies.ts'

export const SESSION_COOKIE = 'ds_session'

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 `registerAuthGuard` 填入；只有通过鉴权的请求才有值。 */
    user?: AuthUser
  }
}

/** Cookie 优先，其次 `Authorization: Bearer`——脚本和 CLI 用第二种更方便。 */
export function readSessionToken(request: FastifyRequest): string | null {
  const cookie = readCookie(request.headers.cookie, SESSION_COOKIE)
  if (cookie) return cookie

  const header = request.headers.authorization
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return null
}

/**
 * 不需要登录的路由。
 *
 * 只放健康检查和登录本身：`/auth/logout` 也放行——拿着一个已失效的令牌
 * 点退出，不该收到 401，它本来就是在清理登录状态。
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /health',
  'POST /auth/login',
  'POST /auth/logout',
])

/**
 * 只对管理员开放的接口。
 *
 * 前端已经藏了入口，但隐藏不是边界——这里是真正的边界。
 * `/sources` 会暴露工具契约与敏感级别，`/recovery` 会动状态。
 */
const ADMIN_ROUTES: ReadonlySet<string> = new Set([
  'GET /sources',
  'GET /tools',
  'GET /recovery',
  'POST /recovery',
  'GET /auth/audit',
])

export function registerAuthGuard(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', async (request) => {
    const route = request.routeOptions.url ?? request.url.split('?')[0] ?? request.url
    const key = `${request.method} ${route}`
    if (PUBLIC_ROUTES.has(key)) return

    const token = readSessionToken(request)
    const user = token ? ctx.auth.authenticate(token) : null
    if (!user) {
      fail(ErrorCode.UNAUTHENTICATED, '需要登录后才能访问')
    }

    request.user = user

    if (ADMIN_ROUTES.has(key) && user.role !== 'admin') {
      fail(ErrorCode.FORBIDDEN, `当前身份（${user.role}）不能访问 ${route}`)
    }
  })
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (!request.user) fail(ErrorCode.UNAUTHENTICATED, '需要登录后才能访问')
  return request.user
}
