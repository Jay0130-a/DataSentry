import { api } from '../api.ts'
import { ErrorBox, Loading, Panel } from '../components.tsx'
import { useAsync } from '../hooks.ts'

const TYPE_LABELS: Record<string, string> = {
  'mcp-stdio': 'MCP stdio',
  http: 'HTTP API',
  local: '本地进程内',
}

const SENSITIVITY_LABELS: Record<string, string> = {
  public: '公开',
  internal: '内部',
  confidential: '机密',
}

const SIDE_EFFECT_LABELS: Record<string, string> = {
  read: '只读',
  write: '写入',
  publish: '发布',
}

/** 数据源与工具清单——排障时第一眼要看的是「这个工具到底注册成了什么」。 */
export function SourcesView(): React.JSX.Element {
  const { data, error, loading, reload } = useAsync(() => api.listSources(), [])

  return (
    <Panel
      title="数据源"
      subtitle={data ? `${data.length} 个数据源` : '来自 sources/<slug>/config.json'}
      actions={
        <button type="button" className="btn" onClick={reload}>
          刷新
        </button>
      }
    >
      {loading && !data ? <Loading what="数据源" /> : null}
      {error ? <ErrorBox message={error} onRetry={reload} /> : null}

      {data ? (
        <ul className="cards">
          {data.map((source) => (
            <li key={source.slug} className="card">
              <div className="card-head">
                <span className="badge badge-neutral">{TYPE_LABELS[source.type] ?? source.type}</span>
                <strong>{source.title}</strong>
                <span className="muted mono">{source.slug}</span>
                <span className="muted mono">v{source.version}</span>
              </div>

              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>工具</th>
                    <th>说明</th>
                    <th>敏感级别</th>
                    <th>副作用</th>
                    <th>需读 guide</th>
                  </tr>
                </thead>
                <tbody>
                  {source.tools.map((tool) => (
                    <tr key={tool.name}>
                      <td className="mono">{tool.name}</td>
                      <td>{tool.title}</td>
                      <td>
                        <span
                          className={`badge badge-${
                            tool.sensitivity === 'confidential' ? 'bad' : 'neutral'
                          }`}
                        >
                          {SENSITIVITY_LABELS[tool.sensitivity] ?? tool.sensitivity}
                        </span>
                      </td>
                      <td>{SIDE_EFFECT_LABELS[tool.sideEffect] ?? tool.sideEffect}</td>
                      <td>{tool.requiresGuide ? '是' : '否'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  )
}
