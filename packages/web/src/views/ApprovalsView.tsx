import { useState } from 'react'
import { api } from '../api.ts'
import type { CurrentUser } from '../auth.ts'
import { Empty, ErrorBox, Loading, Panel, formatTime, shortHash } from '../components.tsx'
import { useAsync } from '../hooks.ts'

/**
 * 审批队列。
 *
 * 审批人做决定时要能看清「批的是什么」——因此每一条都展示绑定的
 * 参数摘要、工具版本、草稿版本与接收人摘要，而不只是一个工具名。
 *
 * 审批人不能手填：这一步授权的是「Agent 能不能执行这个工具」，
 * 留名必须由登录保证，否则审批记录可以被任何人写成任何人。
 */
export function ApprovalsView({ user }: { user: CurrentUser }): React.JSX.Element {
  const queue = useAsync(() => api.listApprovals(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const decide = async (approvalId: string, decision: 'granted' | 'denied'): Promise<void> => {
    setBusy(approvalId)
    setError(null)
    setNotice(null)
    try {
      const result = await api.decideApproval(approvalId, { decision })
      setNotice(
        `审批 ${approvalId} → ${result.approval.status}；任务 ${result.session.id} 现在处于 ${result.session.state}`,
      )
      queue.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const items = queue.data ?? []

  return (
    <div className="stack">
      <Panel
        title="待审批"
        subtitle={
          items.length > 0
            ? `${items.length} 项等待决定。批准只记录决定，真正的执行在恢复那一步。`
            : '没有待办'
        }
        actions={
          <>
            <span className="muted" title="审批记录会写入当前登录账号">
              以 <strong>{user.displayName}</strong> 身份审批
            </span>
            <button type="button" className="btn" onClick={queue.reload}>
              刷新
            </button>
          </>
        }
      >
        {queue.loading && !queue.data ? <Loading what="待审批队列" /> : null}
        {queue.error ? <ErrorBox message={queue.error} onRetry={queue.reload} /> : null}
        {error ? <ErrorBox message={error} /> : null}
        {notice ? <div className="callout callout-ok">{notice}</div> : null}

        {queue.data && items.length === 0 ? <Empty>队列是空的。</Empty> : null}

        {items.length > 0 ? (
          <ul className="cards">
            {items.map((approval) => (
              <li key={approval.id} className="card">
                <div className="card-head">
                  <span className={`badge badge-${approval.kind === 'publish' ? 'waiting' : 'neutral'}`}>
                    {approval.kind === 'publish' ? '发布确认' : '取数审批'}
                  </span>
                  <span className="mono">{approval.toolName}</span>
                  <span className="muted mono">{approval.id}</span>
                </div>

                <dl className="kv kv-compact">
                  <div>
                    <dt>绑定参数</dt>
                    <dd className="mono">{approval.paramsHash}</dd>
                  </div>
                  <div>
                    <dt>工具版本</dt>
                    <dd className="mono">{approval.toolVersion}</dd>
                  </div>
                  {approval.draftVersion ? (
                    <div>
                      <dt>草稿版本</dt>
                      <dd className="mono">{approval.draftVersion}</dd>
                    </div>
                  ) : null}
                  {approval.recipientsHash ? (
                    <div>
                      <dt>接收人摘要</dt>
                      <dd className="mono">{shortHash(approval.recipientsHash, 16)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>有效期至</dt>
                    <dd>{formatTime(approval.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>任务</dt>
                    <dd className="mono">{approval.sessionId}</dd>
                  </div>
                </dl>

                {approval.authority && !approval.authority.allowed ? (
                  <div className="callout callout-bad">
                    {approval.authority.reason}
                  </div>
                ) : null}

                <div className="card-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy !== null || approval.authority?.allowed === false}
                    onClick={() => void decide(approval.id, 'granted')}
                  >
                    批准
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy !== null || approval.authority?.allowed === false}
                    onClick={() => void decide(approval.id, 'denied')}
                  >
                    拒绝
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  )
}
