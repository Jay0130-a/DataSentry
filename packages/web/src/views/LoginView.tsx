import { useState } from 'react'
import { api } from '../api.ts'

/**
 * 登录页。
 *
 * 只做一件事：把口令换成服务端的 httpOnly 会话 Cookie。
 * 前端不保存令牌——令牌在 JS 读得到的地方，就等于可以被一段注入的脚本带走。
 */
export function LoginView({ onSuccess }: { onSuccess: () => void }): React.JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return

    setBusy(true)
    setError(null)
    try {
      await api.login(username.trim(), password)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="panel login-card" onSubmit={(event) => void submit(event)}>
        <div className="login-head">
          <span className="brand-mark">DS</span>
          <div>
            <h1 className="login-title">DataSentry</h1>
            <p className="panel-sub">报表 Agent 工作台</p>
          </div>
        </div>

        <label className="field">
          <span>用户名</span>
          <input
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoFocus
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>口令</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />
        </label>

        {error ? (
          <div className="error-box">
            <div className="error-text">{error}</div>
          </div>
        ) : null}

        <div className="login-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || username.trim() === '' || password === ''}
          >
            {busy ? '登录中…' : '登录'}
          </button>
        </div>

        {import.meta.env.DEV ? (
          <p className="login-hint">
            开发期初始账号：<span className="mono">admin</span> / <span className="mono">analyst</span>。
            口令取自 <span className="mono">DATASENTRY_ADMIN_PASSWORD</span> 与{' '}
            <span className="mono">DATASENTRY_ANALYST_PASSWORD</span>，未设置时用内置默认口令（见 README）。
          </p>
        ) : null}
      </form>
    </div>
  )
}
