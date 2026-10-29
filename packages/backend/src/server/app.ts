import Fastify, { type FastifyInstance } from 'fastify'
import type { AppContext } from '../context.ts'
import { listWorkspaces } from '../workspace/loader.ts'
import { registerAccessGuard } from './access-guard.ts'
import { registerAuthGuard } from './auth-guard.ts'
import { registerErrorHandler } from './errors.ts'
import { registerApprovalRoutes } from './routes/approvals.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerCatalogRoutes } from './routes/catalog.ts'
import { registerPublishingRoutes } from './routes/publishing.ts'
import { registerRecoveryRoutes } from './routes/recovery.ts'
import { registerSessionRoutes } from './routes/sessions.ts'

export interface BuildServerOptions {
  logger?: boolean
  /** 账号表为空时是否建初始账号。测试里可以关掉，用自己的账号。 */
  seedUsers?: boolean
}

/**
 * Fastify 应用（M1 的 Console 交付形态，PRD §10）。
 *
 * 路由按「目录类」「任务类」「审批类」「发布类」分文件注册：
 * M3 加 WebUI 需要的查询接口、M4 加回执与结果未知处理，都只是多一次 register。
 */
export function buildServer(ctx: AppContext, options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    /*
     * 只有明确声明「我在反向代理后面」才采信 X-Forwarded-For。
     * 默认不采信：否则任何人都能伪造来源 IP，登录审计里的 IP 就失去意义。
     */
    trustProxy: process.env['DATASENTRY_TRUST_PROXY'] === '1',
  })

  // 空 body 视为 {}。
  //
  // `POST /sessions/:id/run` 这类无参数动作接口，客户端很自然会带上
  // `content-type: application/json` 却不发 body。Fastify 默认会因此报 400，
  // 而这既不是安全问题也不表达任何业务含义，只会让调用方反复踩坑。
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (!body || body.trim() === '') return done(null, {})
      try {
        done(null, JSON.parse(body))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  registerErrorHandler(app)

  if (options.seedUsers !== false) {
    const seeded = ctx.auth.ensureSeeded(
      process.env,
      listWorkspaces(ctx.paths).map((workspace) => workspace.id),
    )
    if (seeded.created.length > 0) {
      const granted =
        seeded.grantedWorkspaces.length > 0
          ? `业务用户被授权 Workspace：${seeded.grantedWorkspaces.join(', ')}`
          : ''
      app.log.warn(
        seeded.defaultPasswords
          ? `已创建初始账号 ${seeded.created.join(' / ')}，使用的是内置默认口令。请通过 DATASENTRY_ADMIN_PASSWORD、DATASENTRY_ANALYST_PASSWORD 覆盖后重建账号。${granted}`
          : `已创建初始账号 ${seeded.created.join(' / ')}。${granted}`,
      )
    }
  }

  // 鉴权钩子必须先注册：它要给后面所有路由兜底。
  registerAuthGuard(app, ctx)
  registerAccessGuard(app, ctx)
  registerAuthRoutes(app, ctx)
  registerCatalogRoutes(app, ctx)
  registerSessionRoutes(app, ctx)
  registerApprovalRoutes(app, ctx)
  registerPublishingRoutes(app, ctx)
  registerRecoveryRoutes(app, ctx)

  return app
}
