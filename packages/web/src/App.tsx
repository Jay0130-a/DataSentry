import { useEffect } from 'react'
import { api } from './api.ts'
import { can, roleLabel, type CurrentUser, type Permission } from './auth.ts'
import { Panel } from './components.tsx'
import { navigate, useAsync, useRoute, type Route } from './hooks.ts'
import { SessionsView } from './views/SessionsView.tsx'
import { SessionDetailView } from './views/SessionDetailView.tsx'
import { EventsView } from './views/EventsView.tsx'
import { ApprovalsView } from './views/ApprovalsView.tsx'
import { RecoveryView } from './views/RecoveryView.tsx'
import { SourcesView } from './views/SourcesView.tsx'
import { AuditView } from './views/AuditView.tsx'
import { LoginView } from './views/LoginView.tsx'

interface NavItem {
  to: string
  label: string
  match: Route['name'][]
  permission?: Permission
}

const NAV: readonly NavItem[] = [
  { to: '#/sessions', label: '任务', match: ['sessions', 'session', 'session-events'] },
  { to: '#/approvals', label: '审批', match: ['approvals'] },
  // 恢复会动状态、数据源会暴露工具契约，都属于系统运维视角，不对业务用户开放。
  // 前端只是不显示入口，真正的边界在服务端（/sources、/recovery 会 403）。
  { to: '#/recovery', label: '恢复', match: ['recovery'], permission: 'recovery.manage' },
  { to: '#/sources', label: '数据源', match: ['sources'], permission: 'sources.view' },
  { to: '#/audit', label: '审计', match: ['audit'], permission: 'audit.view' },
]

function requiredPermission(route: Route): Permission | null {
  if (route.name === 'recovery') return 'recovery.manage'
  if (route.name === 'sources') return 'sources.view'
  if (route.name === 'audit') return 'audit.view'
  return null
}

function NoAccess({ route }: { route: Route }): React.JSX.Element {
  const label =
    route.name === 'sources' ? '数据源' : route.name === 'audit' ? '审计' : '恢复'
  return (
    <Panel title="无权访问" subtitle={`当前身份看不到${label}页`}>
      <p className="muted">
        这个页面属于系统运维视角，只对管理员开放。业务用户需要取数、审批、发起发布，请从「任务」和「审批」进入。
      </p>
    </Panel>
  )
}

export function App(): React.JSX.Element {
  const route = useRoute()
  const me = useAsync(() => api.me(), [])
  const user: CurrentUser | null = me.data?.user ?? null

  // 模型信息只对已登录用户可见：它属于运行环境，不该在登录前暴露。
  const meta = useAsync(
    () => (user ? api.meta() : Promise.resolve(null)),
    [user?.id],
  )

  // 会话过期或被吊销时，任何一次请求都会触发这个事件，统一回到登录页。
  useEffect(() => {
    const onUnauthorized = (): void => {
      // 只 reload 不够：display 的 user 来自旧 data，会继续停在已登录界面。
      me.reset()
      me.reload()
    }
    window.addEventListener('datasentry:unauthorized', onUnauthorized)
    return () => window.removeEventListener('datasentry:unauthorized', onUnauthorized)
  }, [me.reload, me.reset])

  if (!user) {
    if (me.loading) {
      return (
        <div className="login-page">
          <p className="muted">正在确认登录状态…</p>
        </div>
      )
    }
    return <LoginView onSuccess={me.reload} />
  }

  const model = meta.data?.model
  const modelLabel = model
    ? model.provider === 'mock'
      ? 'Mock 规划器'
      : model.name
    : null

  const needed = requiredPermission(route)
  const denied = needed !== null && !can(user, needed)

  const logout = async (): Promise<void> => {
    try {
      await api.logout()
    } finally {
      // /auth/me 的 401 被 api.ts 排除在 unauthorized 事件之外，只 reload 会保留旧 user。
      me.reset()
      me.reload()
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">DS</span>
          <div>
            <div className="brand-name">DataSentry</div>
            <div className="brand-sub">报表 Agent 工作台</div>
          </div>
        </div>

        <div className="topbar-right">
          {modelLabel ? (
            <span
              className={`badge ${model?.provider === 'mock' ? 'badge-neutral' : 'badge-ok'}`}
              title={
                model?.provider === 'mock'
                  ? '确定性规划器：按 plan.yaml 执行，不调用模型、不产生费用'
                  : `${model?.name} · effort=${model?.effort} · 凭据来源 ${model?.credentials.source ?? '未知'}`
              }
            >
              模型：{modelLabel}
            </span>
          ) : null}

          <span className="user-chip" title={user.displayName}>
            <span className="mono">{user.username}</span>
            <span className="badge badge-neutral">{roleLabel(user.role)}</span>
            <button type="button" className="link" onClick={() => void logout()}>
              退出
            </button>
          </span>

          <nav className="nav">
            {NAV.filter((item) => !item.permission || can(user, item.permission)).map((item) => (
              <button
                key={item.to}
                type="button"
                className={item.match.includes(route.name) ? 'nav-item active' : 'nav-item'}
                onClick={() => navigate(item.to)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="main">
        {denied ? <NoAccess route={route} /> : null}

        {!denied && route.name === 'sessions' && <SessionsView />}
        {!denied && route.name === 'session' && (
          <SessionDetailView key={route.id} sessionId={route.id} user={user} />
        )}
        {!denied && route.name === 'session-events' && (
          <EventsView key={route.id} sessionId={route.id} />
        )}
        {!denied && route.name === 'approvals' && <ApprovalsView user={user} />}
        {!denied && route.name === 'recovery' && <RecoveryView />}
        {!denied && route.name === 'sources' && <SourcesView />}
        {!denied && route.name === 'audit' && <AuditView />}
      </main>
    </div>
  )
}
