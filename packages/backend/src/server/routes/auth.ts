import type { FastifyInstance } from 'fastify'
import { ErrorCode, fail } from '@datasentry/core'
import type { AppContext } from '../../context.ts'
import { requireUser, readSessionToken, SESSION_COOKIE } from '../auth-guard.ts'
import { serializeCookie } from '../cookies.ts'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/auth/login', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const username = body['username']
    const password = body['password']
    if (typeof username !== 'string' || typeof password !== 'string') {
      fail(ErrorCode.SCHEMA_INVALID, '需要 username 与 password')
    }

    const result = ctx.auth.login({
      username,
      password,
      ...(request.headers['user-agent'] !== undefined
        ? { userAgent: request.headers['user-agent'] }
        : {}),
      ip: request.ip,
    })

    reply.header(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, result.token, {
        maxAgeSeconds: Math.floor(ctx.auth.sessionTtlMs / 1000),
        httpOnly: true,
        secure: request.protocol === 'https',
        sameSite: 'Lax',
      }),
    )

    return { user: result.user, expiresAt: result.expiresAt }
  })

  app.post('/auth/logout', async (request, reply) => {
    const token = readSessionToken(request)
    if (token) {
      ctx.auth.logout(token, {
        ip: request.ip,
        ...(request.headers['user-agent'] !== undefined
          ? { userAgent: request.headers['user-agent'] }
          : {}),
      })
    }

    reply.header(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, '', {
        maxAgeSeconds: 0,
        httpOnly: true,
        secure: request.protocol === 'https',
        sameSite: 'Lax',
      }),
    )
    return { ok: true }
  })

  app.get('/auth/me', async (request) => ({ user: requireUser(request) }))

  /** 登录审计。仅管理员可见——它能回答「谁在什么时候从哪登录过」。 */
  app.get('/auth/audit', async (request) => {
    const { limit } = request.query as { limit?: string }
    const parsed = limit ? Number(limit) : 50
    return ctx.auth.recentAudit(Number.isFinite(parsed) ? parsed : 50)
  })
}
