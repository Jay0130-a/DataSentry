import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dataPaths,
  ErrorCode,
  fail,
  isSafePathSegment,
  workspaceFileSchema,
  type DataPaths,
  type Workspace,
} from '@datasentry/core'

export interface LoadedWorkspace extends Workspace {
  path: string
}

/**
 * 加载 `workspaces/<dir>/workspace.json`。
 *
 * Workspace 承担的是**配置与工具访问边界**：它声明能用哪些 Source、哪些 Skill、
 * 默认哪个 Permission Mode。它**不是**数据库行级权限——一个用户能不能看到
 * 某张表的某几行，是数据平台的职责。这条边界在 PRD §12.5 被专门点出来，
 * 因为把两者混为一谈是这类系统最常见的越权来源。
 */
export function loadWorkspace(ref: string, paths: DataPaths = dataPaths()): LoadedWorkspace {
  assertSafeWorkspaceRef(ref)
  const file = resolveWorkspaceFile(ref, paths)
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const result = workspaceFileSchema.safeParse(parsed)

  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `${file} 不符合 Workspace 契约：${first ? `${first.path.join('.')} — ${first.message}` : '未知错误'}`,
    )
  }

  return {
    ...result.data,
    id: result.data.id ?? ref,
    createdAt: new Date().toISOString(),
    path: file,
  }
}

/** Workspace 引用只能是 `workspaces/` 下的一级目录名，不能是路径。 */
function assertSafeWorkspaceRef(ref: string): void {
  if (!isSafePathSegment(ref)) {
    fail(ErrorCode.WORKSPACE_NOT_FOUND, `非法的 Workspace 引用 "${ref}"`, { workspace: ref })
  }
}

function resolveWorkspaceFile(ref: string, paths: DataPaths): string {
  const direct = join(paths.workspaces, ref, 'workspace.json')
  if (existsSync(direct)) return direct

  if (!existsSync(paths.workspaces)) {
    throw new Error(`workspaces 目录不存在：${paths.workspaces}`)
  }
  for (const entry of readdirSync(paths.workspaces, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(paths.workspaces, entry.name, 'workspace.json')
    if (!existsSync(candidate)) continue
    const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { id?: string }
    if (parsed.id === ref || entry.name === ref) return candidate
  }
  fail(ErrorCode.WORKSPACE_NOT_FOUND, `找不到 Workspace "${ref}"（在 ${paths.workspaces} 下）`, {
    workspace: ref,
  })
}

export function listWorkspaces(paths: DataPaths = dataPaths()): LoadedWorkspace[] {
  if (!existsSync(paths.workspaces)) return []
  return readdirSync(paths.workspaces, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(paths.workspaces, entry.name, 'workspace.json')))
    .map((entry) => loadWorkspace(entry.name, paths))
    .sort((a, b) => a.id.localeCompare(b.id))
}
