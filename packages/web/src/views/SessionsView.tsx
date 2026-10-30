import { useState } from 'react'
import { api } from '../api.ts'
import { Empty, ErrorBox, Loading, Panel, StateBadge, formatTime } from '../components.tsx'
import { navigate, useAsync } from '../hooks.ts'

const EXAMPLES = [
  '出 2025 年 9 月的经营月报',
  '生成 2025-08 经营月报，重点看华东',
  '出上个月的经营月报',
]

/** 任务列表 + 发起入口。 */
export function SessionsView(): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.listSessions(), [])

  const attention = (data ?? []).filter((s) =>
    ['WAITING_APPROVAL', 'BLOCKED', 'MANUAL_REVIEW', 'FAILED', 'PAUSED'].includes(s.state),
  )

  return (
    <div className="stack">
      <NewRequestCard onCreated={reload} />

      <Panel
        title="任务"
        subtitle={
          data
            ? `共 ${data.length} 个，其中 ${attention.length} 个需要人工介入`
            : '按创建时间倒序'
        }
        actions={
          <button type="button" className="btn" onClick={reload}>
            刷新
          </button>
        }
      >
        {loading && !data ? <Loading what="任务" /> : null}
        {error ? <ErrorBox message={error} onRetry={reload} /> : null}

        {data && data.length === 0 ? <Empty>还没有任务。上面输入一句需求就能发起。</Empty> : null}

        {data && data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>状态</th>
                <th>需求</th>
                <th className="num">步</th>
                <th>工作区</th>
                <th>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {data.map((session) => (
                <tr
                  key={session.id}
                  className="row-link"
                  onClick={() => navigate(`#/sessions/${session.id}`)}
                >
                  <td>
                    <StateBadge state={session.state} />
                    {session.errorCode ? (
                      <div className="cell-sub code">{session.errorCode}</div>
                    ) : null}
                  </td>
                  <td>
                    <div className="cell-main">{session.request}</div>
                    <div className="cell-sub mono">{session.id}</div>
                  </td>
                  <td className="num">{session.step}</td>
                  <td>{session.workspaceId}</td>
                  <td className="nowrap">{formatTime(session.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  )
}

/**
 * 发起入口。
 *
 * 只要求输入一句人话——期间从这句话里识别。这是「自然语言发起报表」
 * 真正的入口，而不是让用户先翻译成结构化字段。
 */
function NewRequestCard({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const workspaces = useAsync(() => api.listWorkspaces(), [])
  const [workspace, setWorkspace] = useState('')
  const [request, setRequest] = useState('')
  const [autoRun, setAutoRun] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const selected = workspace || workspaces.data?.[0]?.id || ''

  const submit = async (): Promise<void> => {
    if (!selected) {
      setError('请先选择 Workspace')
      return
    }
    if (!request.trim()) {
      setError('请先描述需求')
      return
    }

    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const session = await api.createSession({ workspace: selected, request: request.trim() })
      setNotice(`已创建 ${session.id}，期间 ${String(session.input['period'] ?? '?')}`)
      setRequest('')
      onCreated()

      // 创建成功后立刻离开表单；自动执行交给详情页，避免它先加载到 INIT 快照。
      if (autoRun) {
        sessionStorage.setItem(`datasentry:autorun:${session.id}`, '1')
      }
      navigate(`#/sessions/${session.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="发起报表需求"
      subtitle="直接写一句话。会计期间会从需求里识别；识别不到或前后矛盾时会明确报错，不会替你猜。"
    >
      {workspaces.error ? <ErrorBox message={workspaces.error} onRetry={workspaces.reload} /> : null}

      <div className="composer">
        <div className="composer-row">
          <label className="field">
            <span>工作区</span>
            <select
              className="input"
              value={selected}
              onChange={(event) => setWorkspace(event.target.value)}
              disabled={busy || !workspaces.data}
            >
              {(workspaces.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{item.id}）
                </option>
              ))}
            </select>
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoRun}
              onChange={(event) => setAutoRun(event.target.checked)}
              disabled={busy}
            />
            创建后立即执行
          </label>
        </div>

        <textarea
          className="input composer-textarea"
          rows={3}
          placeholder="例如：出 2025 年 9 月的经营月报"
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit()
          }}
          disabled={busy}
        />

        <div className="composer-footer">
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="chip"
                disabled={busy}
                onClick={() => setRequest(example)}
              >
                {example}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !selected}
            onClick={() => void submit()}
          >
            {busy ? '执行中…' : autoRun ? '发起并执行' : '仅创建'}
          </button>
        </div>

        <p className="hint muted">
          {autoRun
            ? '创建后立即执行；任务若需要审批会停在「等待审批」，去审批页处理。'
            : '只创建任务，之后可在详情页点「执行」。'}
        </p>

        {error ? <ErrorBox message={error} /> : null}
        {notice ? <div className="callout callout-ok">{notice}</div> : null}
      </div>
    </Panel>
  )
}
