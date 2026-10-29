import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.ts'

/**
 * 恢复类接口（PRD FR-04）。
 *
 * 分成只读扫描与执行两步，是因为「进程挂过之后该怎么办」应该是运维看清楚了再决定的事。
 * 一启动就自动重放一堆带副作用的调用，比停在 PAUSED 等指令更危险。
 */
export function registerRecoveryRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** 只读扫描：每个非终态任务会被怎么处理。不改任何状态。 */
  app.get('/recovery', async (request) => {
    const { session } = request.query as { session?: string }
    const findings = ctx.recovery.scan(session ? [session] : undefined)
    return {
      summary: summarize(findings),
      findings,
    }
  })

  /**
   * 执行恢复。
   *
   * body 省略或 `{ execute: false }` 时只做状态收敛（把不一致的任务挪到 PAUSED /
   * MANUAL_REVIEW、标记中断的调用）；`{ execute: true }` 才会真正把可继续的任务跑下去。
   */
  app.post('/recovery', async (request) => {
    const body = (request.body ?? {}) as { execute?: unknown; sessionIds?: unknown }
    const execute = body.execute === true
    const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : undefined

    const result = await ctx.runRecovery({
      execute,
      ...(sessionIds !== undefined ? { sessionIds } : {}),
    })

    return {
      execute,
      summary: summarize(result.findings),
      applied: result.applied,
      resumed: result.resumed,
      errors: result.errors,
    }
  })
}

function summarize(
  findings: readonly { action: string }[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const finding of findings) {
    counts[finding.action] = (counts[finding.action] ?? 0) + 1
  }
  return counts
}
