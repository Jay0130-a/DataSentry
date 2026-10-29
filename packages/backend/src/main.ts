import { createAppContext } from './context.ts'
import { buildServer } from './server/app.ts'

const PORT = Number(process.env['PORT'] ?? 3000)
const HOST = process.env['HOST'] ?? '127.0.0.1'

/**
 * 服务入口（PRD §10 的 Console 交付形态）。
 *
 * 启动时**不**建立 Source 连接：MCP 子进程在第一次真正跑任务时才 spawn。
 * 这样服务能秒起，配置有问题的数据源也不会拖住整个进程。
 */
async function main(): Promise<void> {
  const ctx = await createAppContext()
  const app = buildServer(ctx, { logger: true })

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，正在关闭…`)
    await app.close()
    await ctx.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ port: PORT, host: HOST })
  app.log.info(`DataSentry 已就绪：http://${HOST}:${PORT}`)

  // 启动时**只报告不执行**：把上次进程留下的残局列清楚，
  // 由运维决定是 POST /recovery 收敛还是带 execute 继续。
  const findings = ctx.recovery.scan()
  const attention = findings.filter(
    (f) => f.action !== 'skip-terminal' && f.action !== 'skip-idle',
  )
  if (attention.length > 0) {
    app.log.warn(`发现 ${attention.length} 个需要处理的任务，GET /recovery 查看详情：`)
    for (const finding of attention) {
      app.log.warn(`  ${finding.sessionId}  ${finding.state}  → ${finding.action}：${finding.reason}`)
    }
  } else {
    app.log.info('没有需要恢复的任务。')
  }

  app.log.info('先执行 `npm run seed` 生成模拟数据；任务从 POST /sessions 发起。')
}

main().catch((err: unknown) => {
  process.stderr.write(`启动失败：${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
