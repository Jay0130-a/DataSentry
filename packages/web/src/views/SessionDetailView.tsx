import { useState } from 'react'
import { api, PUBLISH_FORMAT_OPTIONS, type Approval, type PublishFormat, type SessionDetail } from '../api.ts'
import {
  Empty,
  ErrorBox,
  Loading,
  Panel,
  StateBadge,
  formatMetricValue,
  formatTime,
  shortHash,
} from '../components.tsx'
import { navigate, useAsync } from '../hooks.ts'

export function SessionDetailView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const detail = useAsync(() => api.getSession(sessionId), [sessionId])
  const events = useAsync(() => api.getSessionEvents(sessionId), [sessionId])
  const report = useAsync(() => api.getSessionReport(sessionId), [sessionId])
  const approvals = useAsync(() => api.getSessionApprovals(sessionId), [sessionId])

  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reconcileResult, setReconcileResult] = useState<string | null>(null)

  // —— 发布 ——
  const [format, setFormat] = useState<PublishFormat>('xlsx')
  const [channel, setChannel] = useState<'email' | 'im' | 'portal'>('email')
  const [recipients, setRecipients] = useState('board@example.com')
  const [publishMsg, setPublishMsg] = useState<string | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishBusy, setPublishBusy] = useState(false)

  const reloadAll = (): void => {
    detail.reload()
    events.reload()
    report.reload()
    approvals.reload()
  }

  const requestPublish = async (): Promise<void> => {
    const reportId = report.data?.id
    if (!reportId) {
      setPublishError('还没有报表草稿，不能发布')
      return
    }
    const list = recipients.split(',').map((r) => r.trim()).filter(Boolean)
    if (list.length === 0) {
      setPublishError('请填写至少一个接收人')
      return
    }

    setPublishBusy(true)
    setPublishError(null)
    setPublishMsg(null)
    try {
      const result = await api.requestPublish(reportId, { recipients: list, channel, format })
      setPublishMsg(
        `已创建发布确认 ${result.approval.id}：${result.artifact.fileName}` +
          `（${result.artifact.sizeBytes} 字节，摘要 ${result.artifact.sha256.slice(0, 12)}…）。` +
          `批准后在下方点「确认投递」。`,
      )
      reloadAll()
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err))
    } finally {
      setPublishBusy(false)
    }
  }

  const confirmPublish = async (approvalId: string): Promise<void> => {
    setPublishBusy(true)
    setPublishError(null)
    setPublishMsg(null)
    try {
      const result = await api.confirmPublish(approvalId)
      if (result.status === 'published' && result.receipt) {
        setPublishMsg(
          `已投递：${result.receipt.fileName}（${result.receipt.format}，${result.receipt.sizeBytes} 字节）` +
            `→ ${result.receipt.recipients.join(', ')}；回执 ${result.receipt.receiptId}` +
            `${result.receipt.deduplicated ? '（去重命中，未重发）' : ''}`,
        )
      } else {
        setPublishMsg(result.message ?? '该发布确认尚未获批')
      }
      reloadAll()
    } catch (err) {
      setPublishError(err instanceof Error ? err.message : String(err))
    } finally {
      setPublishBusy(false)
    }
  }

  const run = async (kind: 'run' | 'resume' | 'reconcile'): Promise<void> => {
    setPendingAction(kind)
    setActionError(null)
    try {
      if (kind === 'run') await api.runSession(sessionId)
      else if (kind === 'resume') await api.resumeSession(sessionId)
      else {
        const result = await api.reconcilePublish(sessionId)
        setReconcileResult(
          result.status === 'already-published'
            ? `记账已完成，回执 ${result.receiptId}`
            : result.status === 'reconciled'
              ? `网关已有回执 ${result.receipt?.receiptId}，已补齐记账；未重发`
              : `${result.status}：${result.message ?? ''}`,
        )
      }
      reloadAll()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setPendingAction(null)
    }
  }

  const session: SessionDetail | null = detail.data
  const pendingApprovals = (approvals.data ?? []).filter((a) => a.status === 'pending')
  const latestApproval = (approvals.data ?? []).at(-1) ?? null
  // 发布确认的执行入口是「确认投递」，不是恢复执行：
  // 恢复会把取数循环重放一遍，报表被再算一次，会话状态也会错位。
  const awaitingPublishConfirm =
    session?.state === 'WAITING_APPROVAL' && latestApproval?.kind === 'publish'

  return (
    <div className="stack">
      <Panel
        title="任务概览"
        subtitle={session ? `${session.id} · ${session.workspaceId}` : sessionId}
        actions={
          <>
            <button type="button" className="btn" onClick={reloadAll}>
              刷新
            </button>
            {session?.state === 'INIT' ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendingAction !== null}
                onClick={() => void run('run')}
              >
                {pendingAction === 'run' ? '执行中…' : '执行'}
              </button>
            ) : null}
            {session &&
            (session.state === 'WAITING_APPROVAL' || session.state === 'PAUSED') &&
            !awaitingPublishConfirm ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendingAction !== null || (session.state === 'WAITING_APPROVAL' && pendingApprovals.length > 0)}
                title={
                  session.state === 'WAITING_APPROVAL' && pendingApprovals.length > 0
                    ? '还有待审批项，批准后再恢复'
                    : undefined
                }
                onClick={() => void run('resume')}
              >
                {pendingAction === 'resume' ? '恢复中…' : '恢复执行'}
              </button>
            ) : null}
            {/* 结果未知时查回执：这条路径永远不会重发，所以随时可按 */}
            {report.data ? (
              <button
                type="button"
                className="btn"
                disabled={pendingAction !== null}
                title="查网关回执，补齐本地记账。不会重发。"
                onClick={() => void run('reconcile')}
              >
                {pendingAction === 'reconcile' ? '核对中…' : '核对发布结果'}
              </button>
            ) : null}
          </>
        }
      >
        {detail.loading && !session ? <Loading what="任务详情" /> : null}
        {detail.error ? <ErrorBox message={detail.error} onRetry={detail.reload} /> : null}
        {actionError ? <ErrorBox message={actionError} /> : null}
        {reconcileResult ? <div className="callout callout-ok">{reconcileResult}</div> : null}
        {awaitingPublishConfirm ? (
          <div className="callout">
            发布确认已通过。投递的执行入口是下方审批表里的「确认投递」——那一步会重新核对文件字节、
            接收人与草稿版本；「恢复执行」只用于取数审批，不会在这里重放。
          </div>
        ) : null}

        {session ? (
          <>
            <dl className="kv">
              <div>
                <dt>状态</dt>
                <dd>
                  <StateBadge state={session.state} />
                </dd>
              </div>
              <div>
                <dt>当前步骤</dt>
                <dd>
                  第 {session.step} 步 · 状态版本 v{session.stateVersion}
                </dd>
              </div>
              <div>
                <dt>需求</dt>
                <dd>{session.request}</dd>
              </div>
              <div>
                <dt>技能</dt>
                <dd>
                  {session.skillName}
                  <span className="mono muted">@{session.skillVersion}</span>
                </dd>
              </div>
              <div>
                <dt>发起人</dt>
                <dd title={session.createdBy ?? undefined}>
                  {session.createdByName ?? session.createdBy ?? '—'}
                </dd>
              </div>
              <div>
                <dt>输入</dt>
                <dd className="mono">{JSON.stringify(session.input)}</dd>
              </div>
              <div>
                <dt>轨迹 ID</dt>
                <dd className="mono">{session.traceId}</dd>
              </div>
            </dl>
            {session.errorCode ? (
              <div className="callout callout-bad">
                <strong>{session.errorCode}</strong>
                <span>{session.errorMessage}</span>
              </div>
            ) : null}
          </>
        ) : null}
      </Panel>

      {report.data ? (
        <Panel
          title="报表"
          subtitle={`${report.data.draftVersion} · 规则版本 ${report.data.ruleVersion} · ${report.data.status}`}
        >
          <table className="table">
            <thead>
              <tr>
                <th>指标</th>
                <th className="num">数值</th>
                <th>口径</th>
                <th>完整性</th>
              </tr>
            </thead>
            <tbody>
              {report.data.metrics.map((metric) => (
                <tr key={metric.key}>
                  <td>{metric.label}</td>
                  <td className="num">{formatMetricValue(metric.value, metric.unit)}</td>
                  <td className="muted">{metric.formula}</td>
                  <td>{metric.completeness}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.data.conflicts.length > 0 ? (
            <div className="callout callout-bad">
              <strong>口径冲突</strong>
              {report.data.conflicts.map((c) => (
                <span key={c.metricKey}>{c.description}</span>
              ))}
            </div>
          ) : null}
          {report.data.receiptId ? (
            <div className="callout callout-ok">
              <strong>已发布</strong>
              <span className="mono">回执 {report.data.receiptId}</span>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {report.data ? (
        <Panel
          title="发布"
          subtitle="选择格式后发起确认；批准之后才真正投递。文件在发起确认时就已生成，审批绑定的是它的字节。"
        >
          <div className="composer">
            <div className="composer-row">
              <label className="field">
                <span>发布格式</span>
                <select
                  className="input"
                  value={format}
                  onChange={(event) => setFormat(event.target.value as PublishFormat)}
                  disabled={publishBusy}
                >
                  {PUBLISH_FORMAT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>投递渠道</span>
                <select
                  className="input"
                  value={channel}
                  onChange={(event) =>
                    setChannel(event.target.value as 'email' | 'im' | 'portal')
                  }
                  disabled={publishBusy}
                >
                  <option value="email">email</option>
                  <option value="im">im</option>
                  <option value="portal">portal</option>
                </select>
              </label>
            </div>

            <input
              className="input"
              placeholder="接收人，逗号分隔（须在 Workspace 分发名单内）"
              value={recipients}
              onChange={(event) => setRecipients(event.target.value)}
              disabled={publishBusy}
            />

            <div className="composer-footer">
              <span className="hint muted">
                同一草稿版本、同一格式、同一批接收人只会投递一次。
              </span>
              <button
                type="button"
                className="btn btn-primary"
                disabled={publishBusy || report.data.status !== 'draft'}
                onClick={() => void requestPublish()}
              >
                {publishBusy ? '处理中…' : '发起发布'}
              </button>
            </div>

            {publishError ? <ErrorBox message={publishError} /> : null}
            {publishMsg ? <div className="callout callout-ok">{publishMsg}</div> : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="审批"
        subtitle={approvals.data ? `共 ${approvals.data.length} 条` : undefined}
      >
        {approvals.data && approvals.data.length === 0 ? <Empty>本次任务没有产生审批。</Empty> : null}
        {approvals.data && approvals.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>状态</th>
                <th>类型</th>
                <th>工具</th>
                <th>绑定</th>
                <th>审批人</th>
                <th>有效期至</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {approvals.data.map((approval) => (
                <ApprovalRow
                  key={approval.id}
                  approval={approval}
                  busy={publishBusy}
                  onConfirm={(id) => void confirmPublish(id)}
                />
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <Panel title="检查点" subtitle="每一步的落点，恢复从这里继续">
        {session && session.checkpoints.length === 0 ? <Empty>还没有检查点。</Empty> : null}
        {session && session.checkpoints.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th className="num">步骤</th>
                <th>状态</th>
                <th className="num">版本</th>
                <th>输出</th>
                <th>审批</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {session.checkpoints.map((checkpoint) => (
                <tr key={`${checkpoint.step}-${checkpoint.stateVersion}`}>
                  <td className="num">{checkpoint.step}</td>
                  <td>
                    <StateBadge state={checkpoint.state} />
                  </td>
                  <td className="num">v{checkpoint.stateVersion}</td>
                  <td className="mono muted">{checkpoint.outputRef ? shortHash(checkpoint.outputRef) : '—'}</td>
                  <td className="mono muted">{checkpoint.approvalRef ? shortHash(checkpoint.approvalRef) : '—'}</td>
                  <td className="nowrap">{formatTime(checkpoint.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <Panel title="工具调用" subtitle="含被拒绝的调用——那是最值得留痕的部分">
        {session && session.toolCalls.length === 0 ? <Empty>还没有工具调用。</Empty> : null}
        {session && session.toolCalls.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>状态</th>
                <th>工具</th>
                <th>参数摘要</th>
                <th>拒绝码</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {session.toolCalls.map((call) => (
                <tr key={call.id}>
                  <td>
                    <span className={`badge badge-${call.status === 'succeeded' ? 'ok' : call.status === 'pending' ? 'waiting' : 'bad'}`}>
                      {call.status}
                    </span>
                  </td>
                  <td className="mono">{call.toolName}</td>
                  <td className="mono muted">{shortHash(call.paramsHash)}</td>
                  <td className="mono">{call.denyCode ?? '—'}</td>
                  <td className="nowrap">{formatTime(call.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <Panel
        title="事件轨迹"
        subtitle={
          events.data
            ? `${events.data.events.length} 条 · 与 data/events/${sessionId}.jsonl 同源`
            : undefined
        }
        actions={
          <button
            type="button"
            className="btn"
            onClick={() => navigate(`#/sessions/${sessionId}/events`)}
          >
            打开事件轨迹
          </button>
        }
      >
        {events.loading && !events.data ? <Loading what="轨迹" /> : null}
        {events.error ? <ErrorBox message={events.error} onRetry={events.reload} /> : null}
        <p className="muted">
          执行轨迹已独立成页：可按类型筛选、按关键字检索，序号与 JSONL 一致。这里只保留入口，
          避免把「这份报表能不能发」和「系统做了哪些动作」挤在同一屏。
        </p>
      </Panel>
    </div>
  )
}

function ApprovalRow({
  approval,
  busy,
  onConfirm,
}: {
  approval: Approval
  busy: boolean
  onConfirm: (approvalId: string) => void
}): React.JSX.Element {
  return (
    <tr>
      <td>
        <span
          className={`badge badge-${
            approval.status === 'granted' ? 'ok' : approval.status === 'pending' ? 'waiting' : 'bad'
          }`}
        >
          {approval.status}
        </span>
      </td>
      <td>{approval.kind === 'publish' ? '发布确认' : '取数审批'}</td>
      <td className="mono">{approval.toolName}</td>
      <td className="mono muted">
        {shortHash(approval.paramsHash, 8)}
        {approval.draftVersion ? ` · ${approval.draftVersion}` : ''}
      </td>
      <td>{approval.approver ?? '—'}</td>
      <td className="nowrap">{formatTime(approval.expiresAt)}</td>
      <td>
        {approval.kind === 'publish' && approval.status === 'granted' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => onConfirm(approval.id)}
          >
            确认投递
          </button>
        ) : null}
      </td>
    </tr>
  )
}
