import type { ReactNode } from 'react'
import type { SessionState } from './api.ts'

const STATE_LABELS: Record<SessionState, string> = {
  INIT: '已创建',
  PLANNING: '规划中',
  FETCHING: '取数中',
  WAITING_APPROVAL: '等待审批',
  COMPUTING: '计算中',
  VALIDATING: '校验中',
  READY: '待发布',
  DONE: '已完成',
  PAUSED: '已暂停',
  BLOCKED: '已阻断',
  MANUAL_REVIEW: '待人工复核',
  FAILED: '失败',
}

const STATE_FAMILY: Record<SessionState, string> = {
  INIT: 'running',
  PLANNING: 'running',
  FETCHING: 'running',
  COMPUTING: 'running',
  VALIDATING: 'running',
  READY: 'ok',
  DONE: 'ok',
  WAITING_APPROVAL: 'waiting',
  PAUSED: 'waiting',
  BLOCKED: 'bad',
  MANUAL_REVIEW: 'bad',
  FAILED: 'bad',
}

export function StateBadge({ state }: { state: SessionState }): React.JSX.Element {
  return (
    <span className={`badge badge-${STATE_FAMILY[state] ?? 'running'}`} title={state}>
      {STATE_LABELS[state] ?? state}
    </span>
  )
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Loading({ what = '数据' }: { what?: string }): React.JSX.Element {
  return <div className="muted">正在加载{what}…</div>
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="error-box">
      <div className="error-text">{message}</div>
      {onRetry ? (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="muted">{children}</div>
}

export function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

export function shortHash(hash: string | null, length = 10): string {
  if (!hash) return '—'
  return `${hash.slice(0, length)}…`
}

export function formatMetricValue(value: number, unit: string): string {
  if (unit === '比率') return `${(value * 100).toFixed(2)}%`
  if (unit === '笔') return `${value.toLocaleString('zh-CN')} 笔`
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
