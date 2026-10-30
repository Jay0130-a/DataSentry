import { Command } from 'commander'
import { isDataSentryError, manualReviewInputSchema } from '@datasentry/core'
import { createAppContext } from './context.ts'
import { listWorkspaces } from './workspace/loader.ts'

const program = new Command()

program
  .name('datasentry')
  .description('DataSentry 报表 Agent 控制台')
  .version('0.1.0')

program
  .command('run')
  .description('发起并执行一次报表任务')
  .requiredOption('-w, --workspace <id>', 'Workspace ID')
  .option('-s, --skill <name>', 'Skill 名称，默认取 Workspace 的第一个')
  .option('-p, --period <YYYY-MM>', '会计期间（省略时会从 --request 里识别）')
  .option('-r, --request <text>', '自然语言需求，例如「出 2025 年 9 月的经营月报」')
  .action(
    async (options: { workspace: string; skill?: string; period?: string; request?: string }) => {
      if (!options.request && !options.period) {
        process.stderr.write(
          '请用 --request 描述需求（例如「出 2025 年 9 月的经营月报」），或直接用 --period 指定期间。\n',
        )
        process.exitCode = 1
        return
      }

      const ctx = await createAppContext()
      try {
        // 只给 --request 时，期间由后端从句子里识别；两者都给且矛盾会报错。
        const request = options.request ?? `出 ${options.period} 的经营月报`
        const session = ctx.createSession({
          workspace: options.workspace,
          request,
          input: options.period ? { period: options.period } : {},
          ...(options.skill !== undefined ? { skill: options.skill } : {}),
        })

        process.stdout.write(`Session ${session.id}（${session.state}）\n`)
        process.stdout.write(`  Skill  ${session.skillName}@${session.skillVersion}\n`)
        process.stdout.write(`  需求   ${session.request}\n`)
        process.stdout.write(`  期间   ${String(session.input['period'])}\n\n`)

        const outcome = await ctx.runSession(session.id)

        for (const event of ctx.events.list(session.id)) {
          process.stdout.write(`  ${String(event.seq).padStart(2, '0')} ${event.type}\n`)
        }

        process.stdout.write(`\n最终状态：${outcome.state}\n`)
        if (outcome.errorCode) {
          process.stdout.write(`错误：${outcome.errorCode} — ${outcome.errorMessage}\n`)
        }
        if (outcome.approvalId) {
          process.stdout.write(`\n等待审批：${outcome.approvalId}\n`)
          process.stdout.write(`  批准：npm run cli -- approvals approve ${outcome.approvalId} -a 财务经理\n`)
          process.stdout.write(`  然后：npm run cli -- resume ${session.id}\n`)
        }
        if (outcome.draftVersion) {
          process.stdout.write(`草稿版本：${outcome.draftVersion}\n`)
          process.stdout.write(`产物：${outcome.artifactPath}\n`)
          process.stdout.write(
            `Markdown：${outcome.artifactPath?.replace(/draft-v1\.json$/, 'draft-v1.md')}\n`,
          )
          const report = ctx.reports.bySession(session.id)
          if (report) {
            process.stdout.write(
              `\n发布：npm run cli -- publish ${report.id} -r board@example.com,audit@example.com\n`,
            )
          }
        }

        if (outcome.state !== 'READY' && outcome.state !== 'DONE' && outcome.state !== 'WAITING_APPROVAL') {
          process.exitCode = 1
        }
      } finally {
        await ctx.close()
      }
    },
  )

const sessions = program.command('sessions').description('查看任务')
sessions
  .command('list')
  .option('-w, --workspace <id>', '按 Workspace 过滤')
  .action(async (options: { workspace?: string }) => {
    const ctx = await createAppContext()
    try {
      const rows = ctx.sessions.list(options.workspace)
      if (rows.length === 0) {
        process.stdout.write('（还没有任务）\n')
        return
      }
      for (const row of rows) {
        process.stdout.write(
          `${row.id}  ${row.state.padEnd(16)} step=${String(row.step).padStart(2)} v=${row.stateVersion}  ${row.request}\n`,
        )
      }
    } finally {
      await ctx.close()
    }
  })

sessions
  .command('show <sessionId>')
  .action(async (sessionId: string) => {
    const ctx = await createAppContext()
    try {
      const session = ctx.sessions.require(sessionId)
      process.stdout.write(`${JSON.stringify(session, null, 2)}\n`)
      process.stdout.write('\n检查点：\n')
      for (const checkpoint of ctx.checkpoints.list(sessionId)) {
        process.stdout.write(
          `  step ${String(checkpoint.step).padStart(2)}  ${checkpoint.state.padEnd(16)} v=${checkpoint.stateVersion}  ${checkpoint.outputRef ?? '-'}\n`,
        )
      }
      process.stdout.write('\n工具调用：\n')
      for (const call of ctx.toolCalls.listBySession(sessionId)) {
        process.stdout.write(
          `  ${call.status.padEnd(10)} ${call.toolName}${call.denyCode ? `  ← ${call.denyCode}` : ''}\n`,
        )
      }
    } finally {
      await ctx.close()
    }
  })

sessions
  .command('review <sessionId>')
  .description('处置 MANUAL_REVIEW 任务（管理员）：retry / accept / fail / block')
  .requiredOption('-r, --resolution <kind>', 'retry | accept | fail | block')
  .requiredOption('--reason <text>', '人工判断依据（写入事件轨迹）')
  .action(async (sessionId: string, options: { resolution: string; reason: string }) => {
    const ctx = await createAppContext()
    try {
      const input = manualReviewInputSchema.parse({
        resolution: options.resolution,
        reason: options.reason,
      })
      const session = ctx.resolveManualReview(sessionId, input)
      process.stdout.write(`已处置 ${session.id} → ${session.state}\n`)
    } finally {
      await ctx.close()
    }
  })

sessions
  .command('events <sessionId>')
  .description('查看事件轨迹（从状态库读，不是读导出文件）')
  .option('--json', '输出原始 JSON 行')
  .action(async (sessionId: string, options: { json?: boolean }) => {
    const ctx = await createAppContext()
    try {
      // 读库而不是读 JSONL：JSONL 是导出，可能落后于事实源。
      const events = ctx.events.list(sessionId)
      if (events.length === 0) {
        process.stdout.write('（没有轨迹。Session 是否存在？）\n')
        return
      }
      for (const event of events) {
        if (options.json) {
          process.stdout.write(`${JSON.stringify(event)}\n`)
        } else {
          process.stdout.write(
            `${String(event.seq).padStart(2, '0')} ${event.at} ${event.type.padEnd(28)} ${JSON.stringify(event.payload)}\n`,
          )
        }
      }
    } finally {
      await ctx.close()
    }
  })

sessions
  .command('export-events <sessionId>')
  .description('从状态库重建事件 JSONL 导出（导出坏了时用）')
  .action(async (sessionId: string) => {
    const ctx = await createAppContext()
    try {
      const count = ctx.events.exportJsonl(sessionId)
      process.stdout.write(`已重建 ${count} 条事件：${ctx.events.jsonlPath(sessionId)}\n`)
    } finally {
      await ctx.close()
    }
  })

const approvals = program.command('approvals').description('审批')

approvals
  .command('list')
  .description('待审批队列')
  .option('-w, --workspace <id>', '按 Workspace 过滤')
  .action(async (options: { workspace?: string }) => {
    const ctx = await createAppContext()
    try {
      ctx.approvals.expireOverdue()
      const rows = ctx.approvals.listPending(options.workspace)
      if (rows.length === 0) {
        process.stdout.write('（没有待审批项）\n')
        return
      }
      for (const row of rows) {
        process.stdout.write(
          `${row.id}  ${row.kind.padEnd(9)} ${row.toolName}\n` +
            `    发起于 ${row.createdAt}  过期于 ${row.expiresAt}\n` +
            `    绑定 paramsHash=${row.paramsHash.slice(0, 12)}…` +
            (row.draftVersion ? `  draft=${row.draftVersion}` : '') +
            (row.recipientsHash ? `  recipients=${row.recipientsHash.slice(0, 12)}…` : '') +
            '\n',
        )
      }
    } finally {
      await ctx.close()
    }
  })

function decideCommand(decision: 'granted' | 'denied') {
  return async (
    approvalId: string,
    options: { approver: string; reason?: string },
  ): Promise<void> => {
    const ctx = await createAppContext()
    try {
      const decided = ctx.decideApproval(approvalId, {
        decision,
        approver: options.approver,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      })
      const session = ctx.sessions.require(decided.sessionId)
      process.stdout.write(
        `审批 ${decided.id} → ${decided.status}（${decided.approver}）\n` +
          `Session ${session.id} 当前状态：${session.state}\n`,
      )
      if (decision === 'granted' && decided.kind === 'tool-call') {
        process.stdout.write(`下一步：npm run cli -- resume ${session.id}\n`)
      }
      if (decision === 'granted' && decided.kind === 'publish') {
        process.stdout.write(`下一步：npm run cli -- confirm-publish ${decided.id}\n`)
      }
    } finally {
      await ctx.close()
    }
  }
}

approvals
  .command('approve <approvalId>')
  .description('批准')
  .requiredOption('-a, --approver <name>', '审批人')
  .option('-r, --reason <text>', '审批意见')
  .action(decideCommand('granted'))

approvals
  .command('deny <approvalId>')
  .description('拒绝')
  .requiredOption('-a, --approver <name>', '审批人')
  .option('-r, --reason <text>', '拒绝理由')
  .action(decideCommand('denied'))

program
  .command('resume <sessionId>')
  .description('审批通过后恢复任务（重放原 ToolCall，不重新规划）')
  .action(async (sessionId: string) => {
    const ctx = await createAppContext()
    try {
      const outcome = await ctx.resumeSession(sessionId)
      process.stdout.write(
        `状态：${outcome.state}  从审批恢复=${outcome.resumed}  步数=${outcome.steps}\n`,
      )
      if (outcome.errorCode) {
        process.stdout.write(`错误：${outcome.errorCode} — ${outcome.errorMessage}\n`)
      }
      if (outcome.draftVersion) {
        process.stdout.write(`草稿版本：${outcome.draftVersion}\n产物：${outcome.artifactPath}\n`)
      }
      if (outcome.state !== 'READY' && outcome.state !== 'DONE') process.exitCode = 1
    } finally {
      await ctx.close()
    }
  })

program
  .command('publish <reportId>')
  .description('发起发布确认（前置校验 + 渲染文件 + 绑定草稿版本与接收人）')
  .requiredOption('-r, --recipients <list>', '接收人，逗号分隔')
  .option('-c, --channel <channel>', '投递渠道 email / im / portal', 'email')
  .option('-f, --format <format>', '发布格式 xlsx / docx / pdf / md', 'xlsx')
  .action(
    async (
      reportId: string,
      options: { recipients: string; channel: string; format: string },
    ) => {
      const ctx = await createAppContext()
      try {
        const result = await ctx.requestPublish(reportId, {
          recipients: options.recipients.split(',').map((r) => r.trim()).filter(Boolean),
          channel: options.channel as 'email' | 'im' | 'portal',
          format: options.format as 'xlsx' | 'docx' | 'pdf' | 'md',
        })
        const args = result.toolCall.args as Record<string, unknown>
        process.stdout.write(
          `发布确认已创建：${result.approval.id}\n` +
            `  草稿版本：${result.approval.draftVersion}\n` +
            `  发布格式：${String(args['format'])}\n` +
            `  文件：${String(args['fileName'])}（${Number(args['sizeBytes'])} 字节）\n` +
            `  内容摘要：${String(args['sha256']).slice(0, 16)}…\n` +
            `  接收人：${result.precheck.recipients.join(', ')}\n` +
            `  过期于：${result.approval.expiresAt}\n`,
        )
        for (const warning of result.precheck.warnings) {
          process.stdout.write(`  提醒：${warning}\n`)
        }
        process.stdout.write(
          `\n批准：npm run cli -- approvals approve ${result.approval.id} -a 财务总监\n` +
            `然后：npm run cli -- confirm-publish ${result.approval.id}\n`,
        )
      } finally {
        await ctx.close()
      }
    },
  )

program
  .command('confirm-publish <approvalId>')
  .description('确认并执行发布（执行前重新核对绑定）')
  .action(async (approvalId: string) => {
    const ctx = await createAppContext()
    try {
      const result = await ctx.confirmPublish(approvalId)
      if (result.status === 'pending') {
        process.stdout.write(`该发布确认尚未获批（${result.approvalId}）\n`)
        process.exitCode = 1
        return
      }
      if (result.status === 'already-published') {
        process.stdout.write(`该报表已经发布，回执 ${result.receiptId || '（未记录）'}；未重复投递\n`)
        return
      }
      process.stdout.write(
        `已发布：回执 ${result.receipt.receiptId}\n` +
          `  接收人：${result.receipt.recipients.join(', ')}\n` +
          `  渠道：${result.receipt.channel}\n` +
          `  时间：${result.receipt.publishedAt}\n` +
          `  去重命中：${result.receipt.deduplicated}\n`,
      )
    } finally {
      await ctx.close()
    }
  })

program
  .command('recover')
  .description('重启后核对中断的任务（默认只收敛状态，不改动业务数据）')
  .option('-s, --session <id>', '只处理某个 Session')
  .option('-x, --execute', '收敛之后继续执行可恢复的任务')
  .action(async (options: { session?: string; execute?: boolean }) => {
    const ctx = await createAppContext()
    try {
      const sessionIds = options.session ? [options.session] : undefined
      const findings = ctx.recovery.scan(sessionIds)

      process.stdout.write(
        `扫描到 ${findings.length} 个任务${options.execute ? '（将执行恢复）' : '（仅收敛状态）'}\n\n`,
      )
      for (const finding of findings) {
        const mark = finding.action.startsWith('skip') ? '·' : '!'
        process.stdout.write(
          `${mark} ${finding.sessionId}  ${finding.state.padEnd(16)} step=${String(finding.step).padStart(2)}  已完成 ${finding.completedSteps} 步\n` +
            `    → ${finding.action}：${finding.reason}\n`,
        )
        if (finding.lastCheckpoint) {
          process.stdout.write(
            `    最后检查点：第 ${finding.lastCheckpoint.step} 步（${finding.lastCheckpoint.state}）` +
              (finding.lastCheckpoint.approvalRef
                ? `  审批 ${finding.lastCheckpoint.approvalRef}`
                : '') +
              '\n',
          )
        }
      }

      if (!options.execute) {
        const needAttention = findings.filter(
          (f) => f.action !== 'skip-terminal' && f.action !== 'skip-idle',
        )
        if (needAttention.length > 0) {
          process.stdout.write(
            `\n${needAttention.length} 个任务需要处理。加 --execute 收敛并继续执行。\n`,
          )
        }
        return
      }

      const result = await ctx.runRecovery({ execute: true, ...(sessionIds ? { sessionIds } : {}) })
      process.stdout.write('\n恢复结果：\n')
      for (const applied of result.applied) {
        process.stdout.write(`  已收敛 ${applied.sessionId}：${applied.detail}\n`)
      }
      for (const resumed of result.resumed) {
        process.stdout.write(
          `  已继续 ${resumed.sessionId}：${resumed.state}` +
            (resumed.errorCode ? `（${resumed.errorCode}）` : '') +
            '\n',
        )
      }
      for (const error of result.errors) {
        process.stdout.write(`  失败 ${error.sessionId}：${error.message}\n`)
      }
      if (result.errors.length > 0) process.exitCode = 1
    } finally {
      await ctx.close()
    }
  })

program
  .command('reconcile <sessionId>')
  .description('发布结果未知时查回执（永不重发）')
  .action(async (sessionId: string) => {
    const ctx = await createAppContext()
    try {
      const result = await ctx.reconcilePublish(sessionId)
      switch (result.status) {
        case 'already-published':
          process.stdout.write(`本地记账已完成，回执 ${result.receiptId}\n`)
          return
        case 'reconciled':
          process.stdout.write(
            `网关已有回执：${result.receipt.receiptId}\n` +
              `  接收人：${result.receipt.recipients.join(', ')}\n` +
              `  发布时间：${result.receipt.publishedAt}\n` +
              `  已补齐本地记账，**未重发**\n`,
          )
          return
        case 'not-delivered':
          process.stdout.write(
            `判定未投递：${result.reason}\n  可以安全重试（网关按内容幂等去重）\n`,
          )
          return
        case 'unknown':
          process.stdout.write(`无法判定：${result.reason}\n  需要人工确认是否已经发出\n`)
          process.exitCode = 1
          return
      }
    } finally {
      await ctx.close()
    }
  })

program
  .command('models')
  .description('查看当前生效的模型配置（不含密钥）')
  .action(async () => {
    const ctx = await createAppContext()
    try {
      const info = ctx.model.describe()
      const config = ctx.model.config
      process.stdout.write(`${JSON.stringify(info, null, 2)}\n\n`)

      process.stdout.write('来源：环境变量 > .env > datasentry.config.json > 默认值\n')
      process.stdout.write(
        '改配置：编辑 .env（密钥与 provider）或 datasentry.config.json（名称、上限、effort）\n',
      )
      process.stdout.write(
        `切换到真实模型：在 .env 里写 DATASENTRY_MODEL_PROVIDER=anthropic 与 DATASENTRY_MODEL_API_KEY=...\n`,
      )
      if (config.provider === 'mock') {
        process.stdout.write(
          '\n当前是确定性规划器：按 Skill 的 plan.yaml 执行，不调用任何模型，不产生费用。\n' +
            '（上面的 credentials 只是「切到 anthropic 时会用什么」，现在不会被使用。）\n',
        )
      }
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    } finally {
      await ctx.close()
    }
  })

program
  .command('sources')
  .description('列出 Source 与工具')
  .action(async () => {
    const ctx = await createAppContext()
    try {
      for (const source of ctx.builder.loadAll()) {
        process.stdout.write(
          `${source.config.slug.padEnd(12)} ${source.config.type.padEnd(10)} v${source.version}  ${source.config.title}\n`,
        )
        for (const tool of source.config.tools) {
          process.stdout.write(
            `  mcp__${source.config.slug}__${tool.name}  [${tool.sensitivity}/${tool.sideEffect}]\n`,
          )
        }
      }
    } finally {
      await ctx.close()
    }
  })

program
  .command('workspaces')
  .description('列出 Workspace')
  .action(async () => {
    const ctx = await createAppContext()
    try {
      for (const workspace of listWorkspaces(ctx.paths)) {
        process.stdout.write(
          `${workspace.id.padEnd(20)} ${workspace.name}  权限=${workspace.defaultPermissionMode}  sources=${workspace.sources.join(',')}\n`,
        )
      }
    } finally {
      await ctx.close()
    }
  })

program.parseAsync(process.argv).catch((err: unknown) => {
  if (isDataSentryError(err)) {
    process.stderr.write(`[${err.code}] ${err.message}\n`)
  } else {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  }
  process.exit(1)
})
