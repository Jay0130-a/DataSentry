import { api } from '../api.ts'
import { Empty, ErrorBox, Loading, Panel, formatTime } from '../components.tsx'
import { useAsync } from '../hooks.ts'

const EVENT_LABELS: Record<string, string> = {
  'login.success': '登录成功',
  'login.failed': '登录失败',
  logout: '退出登录',
}

const EVENT_FAMILY: Record<string, string> = {
  'login.success': 'ok',
  'login.failed': 'bad',
  logout: 'neutral',
}

const REASON_LABELS: Record<string, string> = {
  'bad-password': '口令错误',
  'unknown-user': '账号不存在',
  disabled: '账号已停用',
  'rate-limited': '失败次数过多，已节流',
}

/**
 * 登录审计。
 *
 * 回答的是三个问题：谁登录过、什么时候、从哪台机器。失败的那几条同样重要——
 * 连续失败的来源地址通常比成功的更有信息量。
 */
export function AuditView(): React.JSX.Element {
  const audit = useAsync(() => api.listAudit(100), [])
  const rows = audit.data ?? []

  const failures = rows.filter((row) => row.event === 'login.failed').length

  return (
    <div className="stack">
      <Panel
        title="登录审计"
        subtitle={
          rows.length > 0
            ? `最近 ${rows.length} 条登录记录，其中失败 ${failures} 条`
            : '还没有登录记录'
        }
        actions={
          <button type="button" className="btn" onClick={audit.reload}>
            刷新
          </button>
        }
      >
        {audit.loading && !audit.data ? <Loading what="审计记录" /> : null}
        {audit.error ? <ErrorBox message={audit.error} onRetry={audit.reload} /> : null}
        {audit.data && rows.length === 0 ? <Empty>还没有登录记录。</Empty> : null}

        {rows.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>账号</th>
                <th>事件</th>
                <th>原因</th>
                <th>来源</th>
                <th>客户端</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="nowrap">{formatTime(row.at)}</td>
                  <td className="mono">{row.username}</td>
                  <td>
                    <span className={`badge badge-${EVENT_FAMILY[row.event] ?? 'neutral'}`}>
                      {EVENT_LABELS[row.event] ?? row.event}
                    </span>
                  </td>
                  <td className="muted">
                    {row.reason ? (REASON_LABELS[row.reason] ?? row.reason) : '—'}
                  </td>
                  <td className="mono">{row.ip ?? '—'}</td>
                  <td className="muted ua-cell" title={row.userAgent ?? undefined}>
                    {row.userAgent ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>
    </div>
  )
}
