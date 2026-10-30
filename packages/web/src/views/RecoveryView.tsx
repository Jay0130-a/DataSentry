import { useState } from 'react'
import { api } from '../api.ts'
import { Empty, ErrorBox, Loading, Panel, StateBadge } from '../components.tsx'
import { navigate, useAsync } from '../hooks.ts'

const ACTION_LABELS: Record<string, string> = {
  'skip-terminal': '已终结，不动',
  'skip-idle': '稳定态，等人工',
  'resume-paused': '已暂停，将从检查点继续',
  'awaiting-approval': '仍在等审批',
  'resume-approved': '可直接重放原 ToolCall',
  'awaiting-publish-confirmation': '等人工确认投递',
  'resolve-publish': '查回执补齐记账',
  'apply-denial': '补记审批被拒的后果',
  'mark-interrupted': '执行中断，结果未知',
  'continue-from-checkpoint': '从检查点继续',
  'needs-manual-review': '状态不一致，转人工',
}

/**
 * 重启恢复页。
 *
 * 上半部分是**只读扫描**——进程挂过之后每个任务会被怎么处置，看清楚再决定。
 * 下半部分才提供执行。这个顺序是刻意的：一启动就自动重放一堆带副作用的调用，
 * 比停下来等一句指令危险得多。
 */
export function RecoveryView(): React.JSX.Element {
  const scan = useAsync(() => api.scanRecovery(), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.runRecovery>> | null>(null)

  const run = async (execute: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.runRecovery(execute))
      scan.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const findings = scan.data?.findings ?? []
  const attention = findings.filter((f) => !f.action.startsWith('skip'))

  return (
    <div className="stack">
      <Panel
        title="恢复扫描"
        subtitle={`扫描到 ${findings.length} 个任务，其中 ${attention.length} 个需要处理`}
        actions={
          <>
            <button type="button" className="btn" onClick={scan.reload} disabled={busy}>
              重新扫描
            </button>
            <button type="button" className="btn" onClick={() => void run(false)} disabled={busy}>
              仅收敛状态
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void run(true)}
              disabled={busy}
            >
              收敛并继续执行
            </button>
          </>
        }
      >
        {scan.loading && !scan.data ? <Loading what="恢复扫描" /> : null}
        {scan.error ? <ErrorBox message={scan.error} onRetry={scan.reload} /> : null}
        {error ? <ErrorBox message={error} /> : null}

        {result ? (
          <div className="callout callout-ok">
            <strong>{result.execute ? '已执行恢复' : '已收敛状态'}</strong>
            <span>
              改动 {result.applied.length} 个 · 继续执行 {result.resumed.length} 个 · 失败{' '}
              {result.errors.length} 个
            </span>
          </div>
        ) : null}

        {scan.data && findings.length === 0 ? <Empty>还没有任何任务。</Empty> : null}

        {findings.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">状态</th>
                <th scope="col">任务</th>
                <th scope="col" className="num">已完成</th>
                <th scope="col">最后检查点</th>
                <th scope="col">恢复结论</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => (
                <tr key={finding.sessionId}>
                  <td>
                    <StateBadge state={finding.state} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => navigate(`#/sessions/${finding.sessionId}`)}
                    >
                      <span className="mono">{finding.sessionId}</span>
                    </button>
                    <div className="cell-sub">{finding.reason}</div>
                  </td>
                  <td className="num">{finding.completedSteps} 步</td>
                  <td className="muted">
                    {finding.lastCheckpoint
                      ? `第 ${finding.lastCheckpoint.step} 步（${finding.lastCheckpoint.state}）`
                      : '—'}
                  </td>
                  <td>
                    <span className={`badge badge-${finding.action.startsWith('skip') ? 'neutral' : 'waiting'}`}>
                      {ACTION_LABELS[finding.action] ?? finding.action}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      {result && (result.applied.length > 0 || result.resumed.length > 0) ? (
        <Panel title="本次改动明细">
          <ul className="list">
            {result.applied.map((item) => (
              <li key={`applied-${item.sessionId}`}>
                <span className="mono">{item.sessionId}</span> — {item.detail}
              </li>
            ))}
            {result.resumed.map((item) => (
              <li key={`resumed-${item.sessionId}`}>
                <span className="mono">{item.sessionId}</span> — 已继续执行，当前状态 {item.state}
                {item.errorCode ? `（${item.errorCode}）` : ''}
              </li>
            ))}
            {result.errors.map((item) => (
              <li key={`error-${item.sessionId}`} className="code">
                <span className="mono">{item.sessionId}</span> — {item.message}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}
