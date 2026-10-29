import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.ts'
import { requireUser } from '../auth-guard.ts'
import { listWorkspaces } from '../../workspace/loader.ts'

/** 只读目录类接口：Workpace、Source 配置、工具清单。 */
export function registerCatalogRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async () => ({ status: 'ok', service: 'datasentry' }))

  /**
   * 运行环境自述。
   *
   * 前端用它显示「当前用的是哪个模型」——排查问题时第一件事就是确认这个，
   * 因为 Mock 与真实模型的失败方式完全不同。
   */
  app.get('/meta', async () => ({
    service: 'datasentry',
    model: ctx.model.describe(),
  }))

  app.get('/workspaces', async (request) => {
    const user = requireUser(request)
    const scope = ctx.auth.workspaceScopeOf(user)

    return listWorkspaces(ctx.paths)
      .filter((workspace) => scope === null || scope.includes(workspace.id))
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        sources: workspace.sources,
        skills: workspace.skills,
        defaultPermissionMode: workspace.defaultPermissionMode,
        ruleVersion: workspace.ruleVersion,
        currency: workspace.currency,
        timezone: workspace.timezone,
      }))
  })

  /**
   * Source 清单只读磁盘配置，**不**建立连接。
   * 这样即使某个数据源挂了，管理页也还能看到它配置成什么样。
   */
  app.get('/sources', async () =>
    ctx.builder.loadAll().map((source) => ({
      slug: source.config.slug,
      title: source.config.title,
      type: source.config.type,
      enabled: true,
      version: source.version,
      authType: source.config.auth.type,
      guide: source.config.guide,
      tools: source.config.tools.map((tool) => ({
        name: `mcp__${source.config.slug}__${tool.name}`,
        title: tool.title,
        sensitivity: tool.sensitivity,
        sideEffect: tool.sideEffect,
        requiresGuide: tool.requiresGuide,
      })),
    })),
  )

  /** 已注册的受控工具。未建立连接前只有内置工具，建立后包含全部 Source 工具。 */
  app.get('/tools', async () => ({
    built: ctx.registry.size > 0,
    tools: ctx.registry.list().map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      sourceSlug: tool.sourceSlug,
      title: tool.title,
      sensitivity: tool.sensitivity,
      sideEffect: tool.sideEffect,
      requiresGuide: tool.requiresGuide,
      toolVersion: tool.toolVersion,
    })),
  }))
}
