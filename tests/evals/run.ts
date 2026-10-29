import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { dataPaths, isDataSentryError, type AgentEvent } from '@datasentry/core'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import type { RunOutcome } from '@datasentry/backend/agent/loop.ts'
import type { SkillPlan } from '@datasentry/backend/harness/skill-loader.ts'
import type { PublishChannel } from '@datasentry/backend/reports/publishing.ts'
import { seedReportingDb } from '@datasentry/backend/sources/reporting-db/seed.ts'
import { seedAll } from '@datasentry/mcp-sources'
import { evalCaseSchema, type EvalCase, type FlowAction } from './case-schema.ts'
import {
  diffWithBaseline,
  fingerprint,
  newRunId,
  readLatestReport,
  writeRegressionReport,
  type CaseReport,
  type RegressionReport,
} from './report.ts'
import { tempPaths } from '../helpers/tmp.ts'

/**
 * 回归不连 SMTP：只组装报文并落盘。
 * 真实投递由冒烟脚本用本地收件器验证——两者分工明确，回归保持离线可复现。
 */
process.env['DATASENTRY_SMTP_MODE'] ??= 'stream'

interface CaseOutcome {
  id: string
  title: string
  path: string
  covers: string[]
  status: 'PASS' | 'FAIL'
  durationMs: number
  failures: string[]
  /** 首个异常步骤——PRD FR-05 验收标准要求输出它。 */
  firstAnomaly: string | null
  actualState: string
  actualEvents: string[]
}

interface FlowResult {
  actionError: { action: string; code: string; message: string } | null
  lastOutcome: RunOutcome | null
  /** 最近一次执行/恢复产生的取数结果条数。 */
  resultCount: number | null
}

const CASES_DIR = join(dataPaths().root, 'tests', 'evals', 'cases')

function loadCases(filter?: string): EvalCase[] {
  const files = readdirSync(CASES_DIR)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()

  const runner = process.env['DATASENTRY_AGENT_LOOP'] === 'pi' ? 'pi' : 'legacy'

  return files
    .map((file) => {
      const parsed = YAML.parse(readFileSync(join(CASES_DIR, file), 'utf8')) as unknown
      const result = evalCaseSchema.safeParse(parsed)
      if (!result.success) {
        const first = result.error.issues[0]
        throw new Error(
          `${file} 不符合样本契约：${first ? `${first.path.join('.')} — ${first.message}` : '未知错误'}`,
        )
      }
      return result.data
    })
    .filter((c) => c.runners.includes(runner))
    .filter((c) => !filter || c.id === filter)
}

/**
 * 有序子序列匹配（PRD FR-05.3）。
 *
 * 实际轨迹里允许穿插其它事件（每次状态变更、每个检查点都会落一条），
 * 但期望序列的**先后顺序**不能被打破——顺序错了就是流程错了。
 */
function matchEventSequence(
  expected: readonly string[],
  actual: readonly string[],
): { ok: true } | { ok: false; index: number; expected: string; message: string } {
  let cursor = 0
  for (let i = 0; i < expected.length; i += 1) {
    const wanted = expected[i]!
    const found = actual.indexOf(wanted, cursor)
    if (found === -1) {
      const seen = actual.slice(cursor)
      return {
        ok: false,
        index: i,
        expected: wanted,
        message:
          `期望序列第 ${i + 1} 项 \`${wanted}\` 未出现。` +
          `其后实际轨迹为：[${seen.join(', ') || '（无）'}]`,
      }
    }
    cursor = found + 1
  }
  return { ok: true }
}

/**
 * 按剧本执行一个样本。
 *
 * 审批与发布让一条路径变成了「跑 → 停下 → 批 → 继续」的多段式，
 * 因此样本描述的是**动作序列**而不是单次调用。动作抛错即中断，
 * 并把错误码记为 `actionError` 供断言——「确认发布时发现绑定已失效」
 * 这类拒绝正是这么表达的。
 */
async function executeFlow(
  env: Omit<
    ActionEnv,
    'sessionId' | 'resolveApproval' | 'ensureReportId' | 'namedApprovals' | 'onOutcome' | 'onResultCount' | 'pendingRun'
  >,
  sessionId: string,
  flow: readonly FlowAction[],
): Promise<FlowResult> {
  const namedApprovals = new Map<string, string>()
  let reportId: string | null = null
  let lastOutcome: RunOutcome | null = null
  let resultCount: number | null = null

  const resolveApproval = async (handle: string): Promise<string> => {
    if (handle !== 'pending') {
      const found = namedApprovals.get(handle)
      if (!found) throw new Error(`样本引用了未创建的审批句柄 "${handle}"`)
      return found
    }

    // pi 循环把 run 放到后台，审批要等它跑到那一步才出现。
    const deadline = Date.now() + 5000
    for (;;) {
      const ctx = env.getCtx()
      ctx.approvals.expireOverdue()
      const pending = ctx.approvals.latestPending(sessionId)
      if (pending) return pending.id
      if (Date.now() > deadline) throw new Error('样本要求审批，但 5 秒内没有出现待审批项')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  const ensureReportId = (): string => {
    if (reportId) return reportId
    const report = env.getCtx().reports.bySession(sessionId)
    if (!report) throw new Error('样本要求发布，但当前 Session 还没有产出报表')
    reportId = report.id
    return reportId
  }

  const actionEnv: ActionEnv = {
    ...env,
    sessionId,
    pendingRun: { current: null },
    resolveApproval,
    ensureReportId,
    namedApprovals,
    onOutcome: (outcome) => {
      lastOutcome = outcome
    },
    onResultCount: (count) => {
      resultCount = count
    },
  }

  for (const action of flow) {
    try {
      await runAction(action, actionEnv)
    } catch (err) {
      // 后台执行还没结束就出错了，先把它收掉，避免挂着的 Promise 影响后续样本。
      actionEnv.pendingRun.current = null
      return {
        lastOutcome,
        resultCount,
        actionError: {
          action: action.action,
          code: isDataSentryError(err) ? err.code : 'UNEXPECTED',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  // 剧本结束后如果还有后台执行没被 resume 收掉，给它一点时间；
  // 仍然没结束说明任务正停在审批上（样本期望的就是这个），不再阻塞。
  if (actionEnv.pendingRun.current) {
    const pending = actionEnv.pendingRun.current
    const settled = await Promise.race([
      pending.then((outcome) => ({ outcome })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ])
    if (settled) {
      lastOutcome = settled.outcome
      resultCount = settled.outcome.results.length
    } else {
      // 任务仍停在审批上：用当前 Session 与悬挂的调用合成一个结果，
      // 让「停在哪一步」这类断言仍然可判。
      const ctx = env.getCtx()
      const session = ctx.sessions.require(sessionId)
      const pending = ctx.toolCalls.pendingBySession(sessionId)
      lastOutcome = {
        sessionId,
        state: session.state,
        errorCode: session.errorCode,
        errorMessage: session.errorMessage,
        steps: 0,
        results: [],
        reportId: null,
        draftVersion: null,
        artifactPath: null,
        stoppedAtIndex: null,
        stoppedAtTool: pending[0]?.toolName ?? null,
        approvalId: null,
        resumed: false,
      }
    }
    actionEnv.pendingRun.current = null
  }

  return { actionError: null, lastOutcome, resultCount }
}

interface ActionEnv {
  /** 当前 AppContext。`restart` 会把它换掉，所以必须通过 getter 取。 */
  getCtx: () => AppContext
  sessionId: string
  /** 样本内联的计划；省略则用 Skill 自带的 plan.yaml。 */
  plan: SkillPlan | undefined
  resolveApproval: (handle: string) => Promise<string>
  ensureReportId: () => string
  namedApprovals: Map<string, string>
  /**
   * pi 循环下 `run` 是后台执行的（审批会在钩子里挂起），
   * `resume` 负责等这次执行真正结束。
   */
  pendingRun: { current: Promise<RunOutcome> | null }
  onOutcome: (outcome: RunOutcome) => void
  /** 恢复动作不产出 RunOutcome，结果条数单独上报。 */
  onResultCount: (count: number) => void
  /** 关掉当前 context，在同一份数据目录上重新起一个（模拟服务重启）。 */
  restart: () => Promise<void>
}

async function runAction(action: FlowAction, env: ActionEnv): Promise<void> {
  const { sessionId } = env

  switch (action.action) {
    case 'run': {
      const promise = env.getCtx().runSession(sessionId, env.plan ? { plan: env.plan } : {})

      /*
       * pi 循环会在 beforeToolCall 里挂起等审批，所以不能无条件 await。
       * 但也不能无条件放后台——没有审批的剧本（比如发布链路）依赖 run 已经跑完。
       * 折中：先等一小会儿；跑完了就正常返回，没跑完说明卡在审批上，转后台。
       */
      if (process.env['DATASENTRY_AGENT_LOOP'] === 'pi') {
        const raced = await Promise.race([
          promise.then((outcome) => ({ outcome })),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ])
        if (raced) {
          env.onResultCount(raced.outcome.results.length)
          env.onOutcome(raced.outcome)
          return
        }
        env.pendingRun.current = promise
        return
      }

      const outcome = await promise
      env.onResultCount(outcome.results.length)
      env.onOutcome(outcome)
      return
    }

    case 'resume': {
      // 后台执行还没结束时，「恢复」就是等它从审批处继续跑完。
      if (env.pendingRun.current) {
        const outcome = await env.pendingRun.current
        env.pendingRun.current = null
        env.onResultCount(outcome.results.length)
        env.onOutcome(outcome)
        return
      }

      const outcome = await env.getCtx().resumeSession(sessionId, env.plan ? { plan: env.plan } : {})
      env.onResultCount(outcome.results.length)
      env.onOutcome(outcome)
      return
    }

    case 'restart':
      // 重启后内存里的执行就没了：丢弃旧 Promise，恢复必须走新的 context。
      env.pendingRun.current = null
      await env.restart()
      return

    case 'recover': {
      const result = await env.getCtx().runRecovery({
        execute: action.execute,
        ...(env.plan ? { plan: env.plan } : {}),
      })
      const mine = result.resumed.find((entry) => entry.sessionId === sessionId)
      if (mine) env.onResultCount(mine.resultCount)
      return
    }

    case 'decide': {
      const approvalId = await env.resolveApproval(action.approval)
      env.getCtx().decideApproval(approvalId, {
        decision: action.decision,
        approver: action.approver,
        ...(action.reason !== undefined ? { reason: action.reason } : {}),
      })
      return
    }

    case 'expire-approval': {
      const ctx = env.getCtx()
      let approvalId: string | undefined
      if (action.approval === 'latest') {
        const row = ctx.database.sqlite
          .prepare(
            'SELECT id FROM approval WHERE session_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(sessionId) as { id: string } | undefined
        approvalId = row?.id
      } else {
        approvalId = env.namedApprovals.get(action.approval)
      }
      if (!approvalId) {
        throw new Error(`样本要过期的审批不存在（句柄 "${action.approval}"）`)
      }
      ctx.database.sqlite
        .prepare('UPDATE approval SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 60_000).toISOString(), approvalId)
      return
    }

    case 'request-publish': {
      const result = await env.getCtx().requestPublish(env.ensureReportId(), {
        recipients: action.recipients,
        channel: action.channel as PublishChannel,
        format: action.format,
      })
      env.namedApprovals.set(action.id, result.approval.id)
      return
    }

    case 'confirm-publish': {
      const approvalId = await env.resolveApproval(action.approval)
      await env.getCtx().confirmPublish(approvalId)
      return
    }

    case 'tamper-params': {
      const ctx = env.getCtx()
      const pending = ctx.toolCalls.pendingBySession(sessionId)
      if (pending.length !== 1) {
        throw new Error(`篡改动作需要恰好一个悬挂的调用，实际有 ${pending.length} 个`)
      }
      const call = pending[0]!
      const period = typeof call.args['period'] === 'string' ? (call.args['period'] as string) : null
      if (!period) throw new Error('篡改动作需要一个含 period 参数的调用')

      // 换成一个**同样合法**的期间：审批批的是 9 月，这里改成 8 月。
      // 刻意不更新 params_hash——这正是要用测试钉死的那个绕过手法。
      const [year, month] = period.split('-').map(Number) as [number, number]
      const tampered = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`

      ctx.database.sqlite
        .prepare('UPDATE tool_call SET args = ? WHERE id = ?')
        .run(JSON.stringify({ ...call.args, period: tampered }), call.id)
      return
    }

    case 'simulate-interrupted-publish': {
      const ctx = env.getCtx()
      const report = ctx.reports.bySession(sessionId)
      if (!report) throw new Error('模拟中断需要一个已产出的报表')

      // 记账回退到投递之前，但网关侧的回执原样保留 —— 这就是那个崩溃窗口。
      ctx.reports.patch(report.id, { status: 'draft', receiptId: null })

      // 直接改库：状态机不允许 DONE → WAITING_APPROVAL，
      // 而「进程崩溃」本来就不是一次状态转移。
      ctx.database.sqlite
        .prepare('UPDATE session SET state = ?, updated_at = ? WHERE id = ?')
        .run('WAITING_APPROVAL', new Date().toISOString(), sessionId)
      return
    }
  }
}

async function runCase(testCase: EvalCase): Promise<CaseOutcome> {
  const startedAt = Date.now()
  const failures: string[] = []
  let actualState = '(未执行)'
  let actualEvents: string[] = []

  const temp = tempPaths(`datasentry-eval-${testCase.id}-`)
  let ctx: AppContext | null = null

  try {
    // 每个样本一份独立的数据目录与随机端口，样本之间不共享任何状态。
    await seedAll(temp.paths)

    // `credentials: false` 用来构造凭据缺失路径：删掉开发凭据文件，
    // 需要凭据的 Source 会以 CREDENTIAL_MISSING 失败，而不是拿空字符串继续跑。
    if (!testCase.credentials) {
      rmSync(temp.paths.credentials, { force: true })
    }

    // 真实数据源的样本自带种子数据：写入这个样本自己的临时目录，
    // 与其它样本互不影响（PGlite 的目录就是 temp.paths.data/pg）。
    if (testCase.seed.includes('reporting-db')) {
      await seedReportingDb({ paths: temp.paths })
    }

    // 强制 Mock：回归样本必须可复现，不能被 `datasentry.config.json` 的模型配置影响。
    ctx = await createAppContext({ paths: temp.paths, modelProvider: 'mock' })

    const session = ctx.createSession({
      workspace: testCase.workspace,
      request: testCase.request,
      input: testCase.input,
      ...(testCase.skill !== undefined ? { skill: testCase.skill } : {}),
    })

    const plan: SkillPlan | undefined = testCase.steps ? { steps: testCase.steps } : undefined

    // `restart` 动作用它把 context 换掉，因此断言一律读这个可变引用。
    const restart = async (): Promise<void> => {
      await ctx!.close()
      ctx = await createAppContext({ paths: temp.paths, modelProvider: 'mock' })
    }

    const flow = await executeFlow(
      { getCtx: () => ctx!, plan, restart },
      session.id,
      testCase.flow,
    )

    const events: AgentEvent[] = ctx.events.readJsonl(session.id)
    actualEvents = events.map((event) => event.type)

    const finalSession = ctx.sessions.require(session.id)
    actualState = finalSession.state

    if (flow.actionError) {
      const expected = testCase.expect.actionError
      if (expected === null) {
        failures.push(
          `动作 "${flow.actionError.action}" 意外失败：[${flow.actionError.code}] ${flow.actionError.message}`,
        )
      } else if (flow.actionError.code !== expected) {
        failures.push(
          `动作错误码期望 ${expected}，实际 ${flow.actionError.code}（${flow.actionError.message}）`,
        )
      }
    } else if (testCase.expect.actionError !== null) {
      failures.push(`期望某个动作以 ${testCase.expect.actionError} 失败，但全部动作都成功了`)
    }

    if (finalSession.state !== testCase.expect.state) {
      failures.push(`终止状态期望 ${testCase.expect.state}，实际 ${finalSession.state}`)
    }

    if (finalSession.errorCode !== testCase.expect.errorCode) {
      failures.push(
        `错误码期望 ${testCase.expect.errorCode ?? '(无)'}，实际 ${finalSession.errorCode ?? '(无)'}` +
          (finalSession.errorMessage ? `（${finalSession.errorMessage}）` : ''),
      )
    }

    if (testCase.expect.stoppedAtTool !== null) {
      const stopped = flow.lastOutcome?.stoppedAtTool ?? null
      if (stopped !== testCase.expect.stoppedAtTool) {
        failures.push(`中断工具期望 ${testCase.expect.stoppedAtTool}，实际 ${stopped ?? '(无)'}`)
      }
    }

    const match = matchEventSequence(testCase.expect.events, actualEvents)
    if (!match.ok) failures.push(match.message)

    if (testCase.expect.resultCount !== undefined) {
      const actual = flow.resultCount ?? 0
      if (actual !== testCase.expect.resultCount) {
        failures.push(`取数结果数期望 ${testCase.expect.resultCount}，实际 ${actual}`)
      }
    }

    if (testCase.expect.approvalCount !== undefined) {
      const actual = ctx.approvals.listBySession(session.id).length
      if (actual !== testCase.expect.approvalCount) {
        failures.push(`审批条数期望 ${testCase.expect.approvalCount}，实际 ${actual}`)
      }
    }

    // 恢复扫描的结论是一条独立断言：它描述的是「重启后系统会怎么处置这个任务」，
    // 与任务最终停在什么状态是两件事。
    if (testCase.expect.recoveryAction !== null) {
      const finding = ctx.recovery.scan([session.id])[0]
      const actual = finding?.action ?? null
      if (actual !== testCase.expect.recoveryAction) {
        failures.push(
          `恢复结论期望 ${testCase.expect.recoveryAction}，实际 ${actual ?? '(无)'}` +
            (finding ? `（${finding.reason}）` : ''),
        )
      }
    }

    if (testCase.expect.noDuplicateToolCalls) {
      const counts = new Map<string, number>()
      for (const call of ctx.toolCalls.listBySession(session.id)) {
        const key = `${call.toolName} ${call.paramsHash.slice(0, 8)}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const duplicated = [...counts.entries()].filter(([, n]) => n > 1)
      if (duplicated.length > 0) {
        failures.push(
          `存在重复的工具调用（说明已完成的步骤被重放了）：${duplicated
            .map(([key, n]) => `${key} ×${n}`)
            .join('；')}`,
        )
      }
    }

    const report = ctx.reports.bySession(session.id)
    const expectedReportStatus = testCase.expect.reportStatus
    if (expectedReportStatus === null) {
      if (report) failures.push('期望不产出报表，但生成了 report 记录')
    } else if (!report) {
      failures.push(`期望报表状态为 ${expectedReportStatus}，但没有 report 记录`)
    } else if (report.status !== expectedReportStatus) {
      failures.push(`报表状态期望 ${expectedReportStatus}，实际 ${report.status}`)
    }

    if (testCase.expect.metricsPresent.length > 0) {
      if (!report) {
        failures.push('期望产出报表，但没有 report 记录')
      } else {
        const present = new Set(report.metrics.map((m) => m.key))
        const missing = testCase.expect.metricsPresent.filter((key) => !present.has(key))
        if (missing.length > 0) failures.push(`报表缺少指标：${missing.join(', ')}`)
      }
    }

    if (testCase.expect.receiptCount !== undefined) {
      // 没有报表时看网关里的全部回执：直接投递会以注入的 reportId 留下回执，
      // 若只看 report 行会漏掉这种「绕过了正常流程但确实发出去了」的回归。
      const actual = report
        ? ctx.publishReceipts(report.id).length
        : ctx.allPublishReceipts().length
      if (actual !== testCase.expect.receiptCount) {
        failures.push(
          `回执条数期望 ${testCase.expect.receiptCount}，实际 ${actual}` +
            (actual > testCase.expect.receiptCount ? '（疑似重复投递）' : ''),
        )
      }
    }

    if (testCase.expect.warningsContaining.length > 0) {
      const warnings = Array.isArray(report?.meta['warnings'])
        ? (report.meta['warnings'] as string[])
        : []
      const joined = warnings.join('\n')
      for (const expected of testCase.expect.warningsContaining) {
        if (!joined.includes(expected)) {
          failures.push(
            `报表注脚里没有找到「${expected}」。实际注脚：[${warnings.join(' | ') || '（空）'}]`,
          )
        }
      }
    }

    // 报表产物必须真实落盘，且能被读回
    if (report?.artifactPath) {
      try {
        JSON.parse(readFileSync(report.artifactPath, 'utf8'))
      } catch (err) {
        failures.push(`报表产物不可读：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    failures.push(`样本准备失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (ctx) await ctx.close().catch(() => undefined)
    temp.cleanup()
  }

  return {
    id: testCase.id,
    title: testCase.title,
    path: testCase.path,
    covers: testCase.covers,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    durationMs: Date.now() - startedAt,
    failures,
    firstAnomaly: failures[0] ?? null,
    actualState,
    actualEvents,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const caseFilter = args.includes('--case') ? args[args.indexOf('--case') + 1] : undefined
  const asJson = args.includes('--json')
  const verbose = args.includes('--verbose')
  const noReport = args.includes('--no-report')

  const cases = loadCases(caseFilter)
  if (cases.length === 0) {
    process.stderr.write('没有匹配的回归样本。\n')
    process.exit(1)
  }

  const startedAt = new Date()
  const paths = dataPaths()
  const baseline = readLatestReport(paths)
  const environment = fingerprint(paths)

  const outcomes: CaseOutcome[] = []
  for (const testCase of cases) {
    outcomes.push(await runCase(testCase))
  }

  const finishedAt = new Date()
  const passed = outcomes.filter((o) => o.status === 'PASS').length

  const caseReports: CaseReport[] = outcomes.map((outcome) => ({
    id: outcome.id,
    title: outcome.title,
    path: outcome.path,
    covers: outcome.covers,
    status: outcome.status,
    durationMs: outcome.durationMs,
    firstAnomaly: outcome.firstAnomaly,
    failures: outcome.failures,
    actualState: outcome.actualState,
    eventCount: outcome.actualEvents.length,
  }))

  const diff = diffWithBaseline(caseReports, baseline)

  const report: RegressionReport = {
    runId: newRunId(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    environment,
    summary: { total: outcomes.length, passed, failed: outcomes.length - passed },
    cases: caseReports,
    baseline: diff,
  }

  const pathsWritten = noReport ? null : writeRegressionReport(report, paths)

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`\nDataSentry 回归报告  ·  ${outcomes.length} 个样本\n`)
    process.stdout.write(`run ${report.runId}  ·  ${report.startedAt}\n`)
    process.stdout.write(`${'─'.repeat(88)}\n`)

    for (const outcome of outcomes) {
      const mark = outcome.status === 'PASS' ? 'PASS' : 'FAIL'
      process.stdout.write(
        `${mark}  ${outcome.id.padEnd(34)} ${(outcome.durationMs / 1000).toFixed(2)}s  ${outcome.title}\n`,
      )
      if (outcome.status === 'FAIL') {
        process.stdout.write(`      首个异常：${outcome.firstAnomaly}\n`)
        for (const failure of outcome.failures.slice(1)) {
          process.stdout.write(`      其它：${failure}\n`)
        }
        if (verbose) {
          process.stdout.write(`      实际轨迹：${outcome.actualEvents.join(' → ')}\n`)
        }
      }
    }

    process.stdout.write(`${'─'.repeat(88)}\n`)

    // 路径覆盖：PRD FR-05.1 要求样本覆盖 8-10 类路径，这里按 path 字段统计。
    const byPath = new Map<string, { total: number; passed: number }>()
    for (const outcome of outcomes) {
      const entry = byPath.get(outcome.path) ?? { total: 0, passed: 0 }
      entry.total += 1
      if (outcome.status === 'PASS') entry.passed += 1
      byPath.set(outcome.path, entry)
    }
    process.stdout.write(`覆盖路径 ${byPath.size} 类：`)
    process.stdout.write(
      [...byPath.entries()]
        .map(([path, counts]) => `${path}(${counts.passed}/${counts.total})`)
        .join('  '),
    )
    process.stdout.write('\n')

    if (diff) {
      const parts: string[] = []
      if (diff.newlyFailing.length > 0) parts.push(`新增失败 ${diff.newlyFailing.join(', ')}`)
      if (diff.newlyPassing.length > 0) parts.push(`新修复 ${diff.newlyPassing.join(', ')}`)
      if (diff.missing.length > 0) parts.push(`上次有而本次未跑 ${diff.missing.join(', ')}`)
      process.stdout.write(
        `与上次（${diff.runId}）相比：${parts.length > 0 ? parts.join('；') : '无变化'}\n`,
      )
    } else {
      process.stdout.write('没有基线可比（这是本机第一次运行）。\n')
    }

    process.stdout.write(`合计：${passed} PASS / ${outcomes.length - passed} FAIL\n`)
    if (pathsWritten) {
      process.stdout.write(`报告：${pathsWritten.runPath}\n`)
      process.stdout.write(`基线：${pathsWritten.latestPath}\n`)
    } else {
      process.stdout.write('（--no-report：未写出报告）\n')
    }
    process.stdout.write('\n')
  }

  process.exit(outcomes.every((o) => o.status === 'PASS') ? 0 : 1)
}

main().catch((err: unknown) => {
  process.stderr.write(`回归执行失败：${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
})
