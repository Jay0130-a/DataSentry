import type { FastifyInstance } from 'fastify'
import { ErrorCode, fail } from '@datasentry/core'
import type { AppContext } from '../context.ts'

/**
 * 资源级边界：能不能看这条任务，取决于它属于哪个 Workspace。
 *
 * 放在钩子里而不是逐个路由里，是因为这类检查最容易漏——新加一个
 * `/sessions/:id/xxx` 接口时，没人会记得补一行权限判断。钩子只要认出
 * 「这个路由带一个资源 id」，就自动覆盖到了。
 *
 * 注意：**可见性按 Workspace 而不是按发起人**。审批人必须能打开别人发起的
 * 任务，否则审批流程直接断掉；发起人只用于审计留痕。
 */
export function registerAccessGuard(app: FastifyInstance, ctx: AppContext): void {
  app.addHook('preHandler', async (request) => {
    const user = request.user
    if (!user) return

    const route = request.routeOptions.url ?? ''
    const id = (request.params as Record<string, string | undefined> | undefined)?.['id']
    if (!id) return

    let sessionId: string | null = null
    if (route.startsWith('/sessions/:')) {
      sessionId = id
    } else if (route.startsWith('/approvals/:')) {
      sessionId = ctx.approvals.require(id).sessionId
    } else if (route.startsWith('/reports/:')) {
      sessionId = ctx.reports.require(id).sessionId
    }

    if (!sessionId) return

    const session = ctx.sessions.require(sessionId)
    if (!ctx.auth.canAccessWorkspace(user, session.workspaceId)) {
      fail(
        ErrorCode.FORBIDDEN,
        `当前身份不能访问 ${session.workspaceId} 的任务`,
        { sessionId, workspaceId: session.workspaceId },
      )
    }
  })
}
