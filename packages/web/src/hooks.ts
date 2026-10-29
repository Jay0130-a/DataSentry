import { useCallback, useEffect, useState } from 'react'

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
  /** 清空当前数据（会话失效时用，避免旧用户/旧任务继续显示）。 */
  reset: () => void
}

/**
 * 一个够用的加载状态封装。
 *
 * 刻意不引数据请求库：这个界面只有五个只读视图加三个动作，
 * 一个 hook 就能覆盖，引 react-query 只会让「看懂它」的成本变高。
 */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const reset = useCallback(() => {
    setData(null)
    setError(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    load()
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  return { data, error, loading, reload, reset }
}

export type Route =
  | { name: 'sessions' }
  | { name: 'session'; id: string }
  | { name: 'session-events'; id: string }
  | { name: 'approvals' }
  | { name: 'recovery' }
  | { name: 'sources' }
  | { name: 'audit' }

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '')
  const [head, id, sub] = path.split('/')
  switch (head) {
    case 'sessions':
      if (id && sub === 'events') return { name: 'session-events', id }
      return id ? { name: 'session', id } : { name: 'sessions' }
    case 'approvals':
      return { name: 'approvals' }
    case 'recovery':
      return { name: 'recovery' }
    case 'sources':
      return { name: 'sources' }
    case 'audit':
      return { name: 'audit' }
    default:
      return { name: 'sessions' }
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

export function navigate(to: string): void {
  window.location.hash = to
}
