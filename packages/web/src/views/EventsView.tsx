import { useMemo, useState } from 'react'
import { api, type AgentEvent } from '../api.ts'
import {
  Empty,
  ErrorBox,
  Loading,
  Panel,
  StateBadge,
  formatTime,
  shortHash,
} from '../components.tsx'
import { navigate, useAsync } from '../hooks.ts'

/** 事件 payload 的一句话摘要——轨迹页要的是「发生了什么」，不是一坨 JSON。 */
function summarizeEvent(event: AgentEvent): string {
  const p = event.payload
  const str = (key: string): string | null =>
    typeof p[key] === 'string' ? (p[key] as string) : null
  const num = (key: string): number | null =>
    typeof p[key] === 'number' ? (p[key] as number) : null

  switch (event.type) {
    case 'session.created':
      return `需求「${str('request') ?? ''}」 · 技能 ${str('skill') ?? ''} · 权限模式 ${str('permissionMode') ?? ''}`
    case 'session.state.changed':
      return `${str('from')} → ${str('to')}${str('reason') ? `（${str('reason')}）` : ''}`
    case 'skill.loaded':
      return `${str('skill')}@${str('skillVersion')} · 依赖 ${(p['requiredSources'] as string[] | undefined)?.join(', ') ?? ''}`
    case 'source.activated':
      return `激活 ${str('sourceSlug')}`
    case 'guide.read':
      return `读取 ${str('sourceSlug')} 的 guide（${num('bytes') ?? 0} 字节）`
    case 'tool.call.requested':
      return `${str('toolName')} · 参数摘要 ${shortHash(str('paramsHash'), 8)}`
    case 'permission.decided':
      return `${str('effect')?.toUpperCase()} · ${str('checkedBy')} · ${str('reason') ?? ''}`
    case 'tool.call.completed':
      return `${str('toolName')} · ${num('rowCount') ?? 0} 行 · 完整性 ${str('completeness') ?? ''}`
    case 'tool.call.failed':
      return `${str('toolName')} · ${str('code') ?? ''} · ${str('reason') ?? str('message') ?? ''}`
    case 'approval.requested':
      return `${str('toolName')} · 敏感级别 ${str('sensitivity') ?? ''} · 过期于 ${formatTime(str('expiresAt') ?? '')}`
    case 'approval.granted':
    case 'approval.denied':
      return `审批人 ${str('approver') ?? ''}${str('reason') ? ` · ${str('reason')}` : ''}`
    case 'checkpoint.saved':
      return `第 ${num('step') ?? 0} 步 · ${str('state') ?? ''} · v${num('stateVersion') ?? 0}` +
        (str('approvalRef') ? ` · 审批 ${shortHash(str('approvalRef'), 8)}` : '')
    case 'metric.computed':
      return `${str('label')} = ${String(p['value'] ?? '')} ${str('unit') ?? ''}`
    case 'validation.failed':
      return `${str('reason') ?? (p['failures'] as string[] | undefined)?.join('；') ?? ''}`
    case 'report.drafted':
      return `草稿 ${str('draftVersion')} · ${num('metricCount') ?? 0} 个指标`
    case 'planning.completed':
      return p['resumed'] ? '从审批恢复，重放原 ToolCall（未重新规划）' : `规划完成 · ${num('steps') ?? 0} 步`
    case 'publish.confirmation.requested':
      return `草稿 ${str('draftVersion') ?? ''} → ${(p['recipients'] as string[] | undefined)?.join(', ') ?? ''}`
    case 'publish.executed':
      return `投递 ${(p['recipients'] as string[] | undefined)?.join(', ') ?? ''}${p['deduplicated'] ? '（去重命中）' : ''}`
    case 'receipt.received':
      return `回执 ${str('receiptId') ?? ''}`
    case 'session.completed':
      return `步数 ${num('steps') ?? 0}`
    default:
      return JSON.stringify(p).slice(0, 160)
  }
}

const EVENT_FAMILY: Record<string, string> = {
  'tool.call.failed': 'bad',
  'validation.failed': 'bad',
  'approval.denied': 'bad',
  'approval.requested': 'waiting',
  'session.state.changed': 'neutral',
  'report.drafted': 'ok',
  'session.completed': 'ok',
  'receipt.received': 'ok',
  'publish.executed': 'ok',
}

interface Filter {
  key: string
  label: string
  match: (event: AgentEvent) => boolean
}

const FILTERS: readonly Filter[] = [
  { key: 'all', label: '全部', match: () => true },
  {
    key: 'problem',
    label: '拒绝与异常',
    match: (e) =>
      e.type === 'tool.call.failed' ||
      e.type === 'validation.failed' ||
      e.type === 'approval.denied' ||
      (e.type === 'permission.decided' && e.payload['effect'] === 'deny'),
  },
  { key: 'approval', label: '审批', match: (e) => e.type.startsWith('approval.') },
  {
    key: 'tool',
    label: '工具调用',
    match: (e) => e.type.startsWith('tool.call.') || e.type === 'guide.read',
  },
  {
    key: 'state',
    label: '状态与检查点',
    match: (e) => e.type.startsWith('session.') || e.type === 'checkpoint.saved',
  },
  {
    key: 'result',
    label: '指标与报表',
    match: (e) => e.type === 'metric.computed' || e.type === 'report.drafted',
  },
]

/**
 * 事件轨迹独立成页。
 *
 * 任务详情回答「这份报表是怎么来的、现在能不能发」；轨迹回答「系统到底
 * 做了哪些动作」。两者读者与密度都不同，混在一页会让人两边都看不完。
 */
export function EventsView({ sessionId }: { sessionId: string }): React.JSX.Element {
  const detail = useAsync(() => api.getSession(sessionId), [sessionId])
  const events = useAsync(() => api.getSessionEvents(sessionId), [sessionId])

  const [filterKey, setFilterKey] = useState('all')
  const [keyword, setKeyword] = useState('')

  const all = events.data?.events ?? []
  const filter = FILTERS.find((item) => item.key === filterKey) ?? FILTERS[0]!

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return all.filter((event) => {
      if (!filter.match(event)) return false
      if (!needle) return true
      const text = `${event.type} ${summarizeEvent(event)}`.toLowerCase()
      return text.includes(needle)
    })
  }, [all, filter, keyword])

  const session = detail.data

  return (
    <div className="stack">
      <Panel
        title="事件轨迹"
        subtitle={
          session
            ? `${session.request} · 与 data/events/${sessionId}.jsonl 同源`
            : sessionId
        }
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => navigate(`#/sessions/${sessionId}`)}>
              返回任务
            </button>
            <button type="button" className="btn btn-ghost" onClick={events.reload}>
              刷新
            </button>
          </>
        }
      >
        {session ? (
          <dl className="kv">
            <div>
              <dt>状态</dt>
              <dd>
                <StateBadge state={session.state} />
              </dd>
            </div>
            <div>
              <dt>需求</dt>
              <dd>{session.request}</dd>
            </div>
            <div>
              <dt>事件数</dt>
              <dd>{all.length}</dd>
            </div>
            <div>
              <dt>任务</dt>
              <dd className="mono">{session.id}</dd>
            </div>
            {session.errorCode ? (
              <div>
                <dt>错误码</dt>
                <dd className="mono">{session.errorCode}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </Panel>

      <Panel title="过滤" subtitle={`当前显示 ${visible.length} / ${all.length} 条`}>
        <div className="toolbar">
          <div className="chips">
            {FILTERS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`chip ${item.key === filterKey ? 'chip-active' : ''}`}
                onClick={() => setFilterKey(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <input
            className="input toolbar-search"
            aria-label="搜索事件"
            placeholder="搜索事件类型或摘要，例如 BLOCKED、审批、revenue"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </div>
      </Panel>

      <Panel title="轨迹" subtitle="按发生顺序（seq）排列，序号与 JSONL 一致">
        {events.loading && !events.data ? <Loading what="轨迹" /> : null}
        {events.error ? <ErrorBox message={events.error} onRetry={events.reload} /> : null}
        {events.data && visible.length === 0 ? <Empty>没有符合条件的事件。</Empty> : null}
        {visible.length > 0 ? (
          <ol className="timeline">
            {visible.map((event) => (
              <li
                key={event.eventId}
                className={`timeline-item family-${EVENT_FAMILY[event.type] ?? 'neutral'}`}
              >
                <span className="timeline-seq">{String(event.seq).padStart(3, '0')}</span>
                <span className="timeline-type">{event.type}</span>
                <span className="timeline-text">{summarizeEvent(event)}</span>
                <span className="timeline-time">{formatTime(event.at)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </Panel>
    </div>
  )
}
