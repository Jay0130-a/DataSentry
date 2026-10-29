/**
 * HTTP API 冒烟脚本。
 *
 * 走完 PRD §11 的验收清单里可通过 API 验证的几条：发起任务、执行、
 * 查事件轨迹、取报表草稿。用法：
 *
 * ```bash
 * npm run dev            # 另开一个终端
 * npm run smoke          # 或 npm run smoke -- http://127.0.0.1:3000
 * ```
 *
 * 之所以用 Node 而不是 curl：中文请求体在 Windows 的 shell 里很容易被
 * 当成非 UTF-8 传出去，导致 Content-Length 对不上，那验证的是 shell 不是服务。
 */
import { dataPaths } from '@datasentry/core'
import { readMailDir, startSmtpSink } from './smtp-sink.ts'

const BASE = process.argv[2] ?? process.env['DATASENTRY_BASE_URL'] ?? 'http://127.0.0.1:3000'

const SMOKE_USER = process.env['DATASENTRY_SMOKE_USER'] ?? 'admin'
const SMOKE_PASSWORD = process.env['DATASENTRY_SMOKE_PASSWORD'] ?? 'datasentry-admin'

/** 登录得到的会话 Cookie。后面的每个请求都要带上它——服务端已经没有匿名入口。 */
let sessionCookie: string | null = null

interface StepReport {
  name: string
  ok: boolean
  detail: string
}

const reports: StepReport[] = []

function record(name: string, ok: boolean, detail: string): void {
  reports.push({ name, ok, detail })
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, BASE), {
    ...init,
    headers: {
      // 没有 body 就不要声明 JSON，否则服务端会等着解析一个不存在的载荷
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} → HTTP ${response.status}：${text.slice(0, 300)}`,
    )
  }
  return JSON.parse(text) as T
}

/** 冒烟脚本用管理员身份：它要访问 /sources 与 /recovery。 */
async function loginAs(username: string, password: string): Promise<string> {
  const response = await fetch(new URL('/auth/login', BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`登录失败：HTTP ${response.status} ${text.slice(0, 200)}`)
  }

  const cookies = response.headers.getSetCookie?.() ?? []
  const session = cookies.find((item) => item.startsWith('ds_session='))
  const cookie = session?.split(';')[0] ?? null
  if (!cookie) throw new Error('登录成功但没有拿到 ds_session Cookie')
  return cookie
}

async function login(): Promise<void> {
  sessionCookie = await loginAs(SMOKE_USER, SMOKE_PASSWORD)
}

async function main(): Promise<void> {
  process.stdout.write(`冒烟目标：${BASE}\n\n`)

  // 0. 登录：除 /health 外所有接口都需要会话
  await login()
  record('登录', true, `以 ${SMOKE_USER} 登录并拿到会话 Cookie`)

  const meta = await api<{ model: { provider: string; name: string } }>('/meta')
  process.stdout.write(
    `模型：${meta.model.name}（provider=${meta.model.provider}）` +
      (meta.model.provider === 'mock' ? '\n\n' : '—— 本次冒烟会真实调用模型\n\n'),
  )

  // 0.5 本地 SMTP 收件器：后端默认往 127.0.0.1:1025 发信，这里接住并落盘。
  const paths = dataPaths()
  const sink = await startSmtpSink({ saveDir: paths.mail, verbose: false }).catch(() => null)
  process.stdout.write(
    sink
      ? `本地 SMTP 收件器：127.0.0.1:${sink.port}，邮件落到 ${paths.mail}\n\n`
      : '本地 SMTP 收件器未启动（端口被占用时可能已有 npm run mail 在跑）\n\n',
  )

  // 1. 健康检查
  const health = await api<{ status: string }>('/health')
  record('健康检查', health.status === 'ok', `status=${health.status}`)

  // 2. Workspace 与 Source
  const workspaces = await api<{ id: string; sources: string[] }[]>('/workspaces')
  const groupFinance = workspaces.find((w) => w.id === 'group-finance')
  record(
    'Workspace 列表',
    Boolean(groupFinance),
    `找到 ${workspaces.length} 个，group-finance 授权 ${groupFinance?.sources.length ?? 0} 个 Source`,
  )

  const sources = await api<{ slug: string; type: string; tools: { name: string }[] }[]>('/sources')
  const types = new Set(sources.map((s) => s.type))
  record(
    'Source 列表',
    sources.length === 6 && types.size === 4,
    `${sources.length} 个 Source / ${types.size} 种接入类型：${sources.map((s) => `${s.slug}(${s.type})`).join(', ')}`,
  )

  const toolNames = sources.flatMap((s) => s.tools.map((t) => t.name))
  const named = toolNames.every((name) => name.startsWith('mcp__'))
  record('工具命名 mcp__{source}__{tool}', named, `${toolNames.length} 个工具`)

  // 3. 发起并执行任务
  const session = await api<{ id: string; state: string }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workspace: 'group-finance',
      request: '出 2025-11 的经营月报',
      input: { period: '2025-11' },
    }),
  })
  record('发起任务', session.state === 'INIT', `session=${session.id} state=${session.state}`)

  const run = await api<{
    state: string
    errorCode: string | null
    errorMessage: string | null
    steps: number
    report: { draftVersion: string; metrics: { key: string }[] } | null
    results: { sourceSlug: string }[]
  }>(`/sessions/${session.id}/run`, { method: 'POST' })

  /*
   * 模型不可用时直接停下来并说清楚：这是账号/网络问题，不是系统故障。
   * 继续往下跑只会得到一串「没有报表」的次生失败，掩盖真正的原因。
   */
  if (run.errorCode === 'MODEL_CALL_FAILED') {
    throw new Error(
      `任务在模型调用处失败（账号或网络问题，不是系统故障）：${run.errorMessage ?? ''}\n` +
        `改用 mock 再跑一次：在 .env 设 DATASENTRY_MODEL_PROVIDER=mock，重启服务后重试。`,
    )
  }

  record(
    '执行任务',
    run.state === 'READY',
    `state=${run.state} steps=${run.steps} 取数 ${run.results.length} 次`,
  )

  const usedSources = [...new Set(run.results.map((r) => r.sourceSlug))].sort()
  record(
    '跨系统取数',
    usedSources.length >= 3,
    `涉及数据源：${usedSources.join(', ')}`,
  )

  // 4. 事件轨迹
  const events = await api<{ events: { seq: number; type: string }[] }>(
    `/sessions/${session.id}/events`,
  )
  const seqs = events.events.map((e) => e.seq)
  const monotonic = seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!)
  const eventTypes = new Set(events.events.map((e) => e.type))
  record(
    '事件轨迹',
    events.events.length > 0 && monotonic,
    `${events.events.length} 条，seq 单调递增=${monotonic}，覆盖 ${eventTypes.size} 种事件`,
  )
  record(
    '审计覆盖',
    eventTypes.has('tool.call.requested') &&
      eventTypes.has('permission.decided') &&
      eventTypes.has('checkpoint.saved'),
    `含工具调用 / 权限判定 / 检查点`,
  )

  // 5. 报表草稿
  const report = await api<{
    id: string
    draftVersion: string
    status: string
    metrics: { key: string; value: number }[]
    dataVersions: Record<string, string>
  }>(`/sessions/${session.id}/report`)
  record(
    '报表草稿',
    report.metrics.length > 0 && Object.keys(report.dataVersions).length >= 3,
    `draftVersion=${report.draftVersion} 指标 ${report.metrics.length} 个，数据版本 ${Object.keys(report.dataVersions).length} 个`,
  )

  // 6. 负向：跨 Workspace 取数被拒
  const denied = await api<{ state: string; errorCode: string | null }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      workspace: 'retail-analytics',
      request: '出 2025-11 的经营月报',
      input: { period: '2025-11' },
    }),
  }).then(async (s) => api<{ state: string; errorCode: string | null }>(`/sessions/${s.id}/run`, { method: 'POST' }))

  record(
    '跨 Workspace 被拒',
    denied.errorCode === 'WORKSPACE_BOUNDARY_VIOLATION',
    `state=${denied.state} code=${denied.errorCode}`,
  )

  // —— M2：发布二次确认 ——
  const reportId = report.id
  const recipients = ['board@example.com', 'audit@example.com']

  // 接收人不在名单内 → 前置校验直接拦下
  let unauthorizedCode = ''
  try {
    await api(`/reports/${reportId}/publish`, {
      method: 'POST',
      body: JSON.stringify({
        recipients: ['outsider@evil.example'],
        channel: 'email',
        format: 'xlsx',
      }),
    })
  } catch (err) {
    unauthorizedCode = err instanceof Error ? err.message : ''
  }
  record(
    '接收人范围校验',
    unauthorizedCode.includes('不在当前 Workspace 的分发名单内'),
    '名单外的接收人被前置校验拒绝',
  )

  const requested = await api<{
    approval: { id: string; draftVersion: string; recipientsHash: string }
    artifact: { format: string; fileName: string; sizeBytes: number; sha256: string }
  }>(`/reports/${reportId}/publish`, {
    method: 'POST',
    body: JSON.stringify({ recipients, channel: 'email', format: 'xlsx' }),
  })
  record(
    '发起发布确认',
    Boolean(requested.approval.draftVersion && requested.approval.recipientsHash),
    `审批 ${requested.approval.id}，绑定 draft=${requested.approval.draftVersion}`,
  )
  record(
    '发布文件已生成',
    requested.artifact.format === 'xlsx' &&
      requested.artifact.sizeBytes > 1000 &&
      /^[0-9a-f]{64}$/.test(requested.artifact.sha256),
    `${requested.artifact.fileName}（${requested.artifact.sizeBytes} 字节，摘要 ${requested.artifact.sha256.slice(0, 12)}…）`,
  )

  const beforeDecision = await api<{ status: string }>(
    `/approvals/${requested.approval.id}/confirm`,
    { method: 'POST' },
  )
  record(
    '未批准不能投递',
    beforeDecision.status === 'pending',
    `status=${beforeDecision.status}`,
  )

  const queue = await api<{ id: string; kind: string; status: string }[]>(
    `/approvals?workspace=group-finance`,
  )
  const queued = queue.find((a) => a.id === requested.approval.id)
  record(
    '待审批队列',
    queued?.status === 'pending' && queued.kind === 'publish',
    `队列中 ${queue.length} 条，目标项 kind=${queued?.kind} status=${queued?.status}`,
  )

  // 发起人不能批自己的任务：这条任务由 admin 发起，admin 自己批应当被拒。
  const selfAttempt = await fetch(new URL(`/approvals/${requested.approval.id}/decide`, BASE), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
    },
    body: JSON.stringify({ decision: 'granted' }),
  })
  const selfBody = await selfAttempt.text()
  const selfCode = (() => {
    try {
      return (JSON.parse(selfBody) as { error?: { code?: string } }).error?.code ?? 'UNKNOWN'
    } catch {
      return 'UNKNOWN'
    }
  })()
  record(
    '发起人不能自批',
    selfAttempt.status === 403 && selfCode === 'APPROVAL_SELF_DENIED',
    `以发起人身份批准自己的任务 → HTTP ${selfAttempt.status} ${selfCode}`,
  )

  // 换成另一位有审批角色的账号来批。
  const ownerCookie = sessionCookie
  sessionCookie = await loginAs('analyst', 'datasentry-analyst')

  // 请求体里的 approver 是刻意写的：它必须被忽略，审批人只能是登录身份。
  const decided = await api<{ approval: { approver: string | null } }>(
    `/approvals/${requested.approval.id}/decide`,
    {
      method: 'POST',
      body: JSON.stringify({ decision: 'granted', approver: '财务总监', reason: '冒烟验证' }),
    },
  )
  record(
    '审批人取自登录身份',
    decided.approval.approver === '业务用户',
    `审批人记录为 ${decided.approval.approver}（请求体里写的「财务总监」未被采信）`,
  )

  sessionCookie = ownerCookie

  const beforeMail = await readMailDir(paths.mail)

  const published = await api<{
    status: string
    receipt: {
      receiptId: string
      recipients: string[]
      deduplicated: boolean
      format: string
      sizeBytes: number
      deliveredPath: string
    }
    report: { status: string; receiptId: string }
  }>(`/approvals/${requested.approval.id}/confirm`, { method: 'POST' })

  record(
    '确认后投递',
    published.status === 'published' && published.receipt.deduplicated === false,
    `回执 ${published.receipt.receiptId} 发往 ${published.receipt.recipients.join(', ')}`,
  )
  record(
    '投递格式与文件',
    published.receipt.format === 'xlsx' &&
      published.receipt.sizeBytes > 1000 &&
      published.receipt.deliveredPath.includes('published'),
    `${published.receipt.format} · ${published.receipt.sizeBytes} 字节 · ${published.receipt.deliveredPath}`,
  )

  const afterMail = await readMailDir(paths.mail)
  const delivered = afterMail.length > beforeMail.length ? afterMail[afterMail.length - 1] : null
  record(
    '邮件已真实投递',
    Boolean(
      delivered &&
        delivered.to.includes('audit@example.com') &&
        delivered.to.includes('board@example.com') &&
        delivered.subject.includes('2025-11') &&
        delivered.attachments.some((item) => item.filename === requested.artifact.fileName),
    ),
    delivered
      ? `标题「${delivered.subject}」· 收件人 ${delivered.to.join(', ')} · 附件 ${delivered.attachments
          .map((item) => `${item.filename} ${item.sizeBytes}B`)
          .join(', ')}`
      : '收件目录没有新邮件——后端的 SMTP 配置可能没指向本地收件器',
  )

  const finalSession = await api<{ state: string }>(`/sessions/${session.id}`)
  record('发布后状态', finalSession.state === 'DONE', `state=${finalSession.state}`)

  const receipts = await api<{ receiptId: string; receipts: { receiptId: string }[] }>(
    `/reports/${reportId}/receipts`,
  )
  record(
    '回执可查',
    receipts.receipts.length === 1 && receipts.receiptId === published.receipt.receiptId,
    `${receipts.receipts.length} 条回执，与报表记录一致`,
  )

  // 结果未知核对：已经记账完成时必须幂等，不能重复投递
  const reconciled = await api<{ status: string; receiptId: string }>(
    `/sessions/${session.id}/reconcile`,
    { method: 'POST' },
  )
  record(
    '结果核对幂等',
    reconciled.status === 'already-published' && reconciled.receiptId === published.receipt.receiptId,
    `status=${reconciled.status}，未产生新回执`,
  )

  // —— 输出 ——
  process.stdout.write(`${'─'.repeat(78)}\n`)
  for (const report of reports) {
    process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'}  ${report.name.padEnd(28)} ${report.detail}\n`)
  }
  process.stdout.write(`${'─'.repeat(78)}\n`)

  const failed = reports.filter((r) => !r.ok)
  process.stdout.write(`合计：${reports.length - failed.length} PASS / ${failed.length} FAIL\n\n`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err: unknown) => {
  process.stderr.write(
    `冒烟失败：${err instanceof Error ? err.message : String(err)}\n` +
      `（服务起来了吗？先执行 npm run dev）\n`,
  )
  process.exit(1)
})
