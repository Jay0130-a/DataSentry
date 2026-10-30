/**
 * 后端接口封装。
 *
 * 所有请求走 `/api` 前缀（开发期由 Vite 代理到后端，生产期交给反向代理），
 * 因此前端代码里不出现任何主机名。
 */

const BASE = '/api'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })

  const text = await response.text()
  if (!response.ok) {
    let code = `HTTP_${response.status}`
    let message = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
      code = parsed.error?.code ?? code
      message = parsed.error?.message ?? message
    } catch {
      // 非 JSON 错误体，保留原文
    }

    // 会话过期/被吊销：通知外层回到登录页。
    // 登录与身份引导这两个接口的 401 不算——它们本来就在回答「现在是谁」。
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      window.dispatchEvent(new Event('datasentry:unauthorized'))
    }

    throw new ApiError(response.status, code, message)
  }

  return JSON.parse(text) as T
}

// —— 类型：只声明界面真正用到的字段 ——

export type SessionState =
  | 'INIT'
  | 'PLANNING'
  | 'FETCHING'
  | 'WAITING_APPROVAL'
  | 'COMPUTING'
  | 'VALIDATING'
  | 'READY'
  | 'DONE'
  | 'PAUSED'
  | 'BLOCKED'
  | 'MANUAL_REVIEW'
  | 'FAILED'

/** 发布格式，与后端保持一致。 */
export type PublishFormat = 'xlsx' | 'docx' | 'pdf' | 'md'

export const PUBLISH_FORMAT_OPTIONS: { value: PublishFormat; label: string }[] = [
  { value: 'xlsx', label: 'Excel (.xlsx)' },
  { value: 'docx', label: 'Word (.docx)' },
  { value: 'pdf', label: 'PDF (.pdf)' },
  { value: 'md', label: 'Markdown (.md)' },
]

export interface SessionSummary {
  id: string
  workspaceId: string
  /** 发起人账号 ID；历史数据或 CLI 发起的任务为 null。只用于审计，不参与鉴权。 */
  createdBy: string | null
  /** 发起人显示名；账号被删除时为 null。 */
  createdByName: string | null
  state: SessionState
  step: number
  stateVersion: number
  skillName: string
  skillVersion: string
  inputVersion: string
  traceId: string
  request: string
  input: Record<string, unknown>
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export interface Checkpoint {
  sessionId: string
  step: number
  stateVersion: number
  inputVersion: string
  outputRef: string | null
  approvalRef: string | null
  state: SessionState
  createdAt: string
}

export interface ToolCallSummary {
  id: string
  toolName: string
  status: 'pending' | 'denied' | 'succeeded' | 'failed'
  paramsHash: string
  denyCode: string | null
  createdAt: string
}

export interface SessionDetail extends SessionSummary {
  checkpoints: Checkpoint[]
  toolCalls: ToolCallSummary[]
}

export interface AgentEvent {
  eventId: string
  sessionId: string
  traceId: string
  seq: number
  type: string
  at: string
  payload: Record<string, unknown>
}

export interface Approval {
  id: string
  kind: 'tool-call' | 'publish'
  sessionId: string
  workspaceId: string
  toolCallId: string
  toolName: string
  toolVersion: string
  paramsHash: string
  draftVersion: string | null
  recipientsHash: string | null
  status: 'pending' | 'granted' | 'denied' | 'expired' | 'revoked'
  approver: string | null
  reason: string | null
  expiresAt: string
  createdAt: string
  decidedAt: string | null
  /** 当前身份能不能批这一条；非待审批状态为 null。 */
  authority: {
    allowed: boolean
    code: string | null
    reason: string | null
    requiredRoles: string[]
  } | null
}

export interface MetricValue {
  key: string
  label: string
  value: number
  unit: string
  formula: string
  inputs: string[]
  completeness: string
}

export interface Report {
  id: string
  sessionId: string
  draftVersion: string
  status: 'draft' | 'confirmed' | 'published' | 'failed'
  ruleVersion: string
  metrics: MetricValue[]
  conflicts: { metricKey: string; description: string }[]
  dataVersions: Record<string, string>
  recipientsHash: string | null
  receiptId: string | null
  artifactPath: string | null
  createdAt: string
}

export interface RecoveryFinding {
  sessionId: string
  workspaceId: string
  state: SessionState
  step: number
  stateVersion: number
  lastCheckpoint: { step: number; state: SessionState; approvalRef: string | null } | null
  pendingToolCall: { id: string; toolName: string } | null
  approval: { id: string; kind: string; status: string; expiresAt: string } | null
  action: string
  reason: string
  completedSteps: number
}

export interface SourceInfo {
  slug: string
  title: string
  type: string
  version: string
  authType: string
  guide: string
  tools: {
    name: string
    title: string
    sensitivity: string
    sideEffect: string
    requiresGuide: boolean
  }[]
}

export interface WorkspaceInfo {
  /** IM 群目标名；webhook key 不在响应里。 */
  imTargets?: string[]
  id: string
  name: string
  sources: string[]
  skills: string[]
  defaultPermissionMode: string
  currency: string
}

export interface ModelInfo {
  provider: string
  name: string
  maxTokens: number
  effort: string
  thinking: boolean
  adaptiveThinking: boolean
  effortSupported: boolean
  credentials: { present: boolean; source: string | null; baseUrl: string | null }
}

// —— 接口 ——

export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: 'analyst' | 'admin'
  /** 审批角色；Workspace 的 approvalPolicy 按这些名字判定资格。 */
  approverRoles: string[]
}

export interface AuthAuditEntry {
  id: string
  event: string
  userId: string | null
  username: string
  at: string
  ip: string | null
  userAgent: string | null
  reason: string | null
}

export const api = {
  meta: () => request<{ service: string; model: ModelInfo }>('/meta'),

  login: (username: string, password: string) =>
    request<{ user: AuthUser; expiresAt: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: AuthUser }>('/auth/me'),

  listAudit: (limit = 50) => request<AuthAuditEntry[]>(`/auth/audit?limit=${limit}`),

  listWorkspaces: () => request<WorkspaceInfo[]>('/workspaces'),

  /**
   * 发起任务。
   *
   * 只传一句 `request`：会计期间由后端从这句话里识别。
   * 识别不到会返回 `REQUEST_PERIOD_MISSING`，识别到多个矛盾期间返回
   * `REQUEST_PERIOD_AMBIGUOUS`——都不会替你猜一个。
   */
  createSession: (body: { workspace: string; request: string; input?: Record<string, unknown> }) =>
    request<SessionSummary>('/sessions', { method: 'POST', body: JSON.stringify(body) }),

  listSessions: (workspace?: string) =>
    request<SessionSummary[]>(`/sessions${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),

  getSession: (id: string) => request<SessionDetail>(`/sessions/${id}`),

  getSessionReport: (id: string) =>
    request<Report>(`/sessions/${id}/report`).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }),

  getSessionEvents: (id: string) => request<{ events: AgentEvent[] }>(`/sessions/${id}/events`),

  getSessionApprovals: (id: string) => request<Approval[]>(`/sessions/${id}/approvals`),

  listApprovals: (workspace?: string) =>
    request<Approval[]>(`/approvals${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`),

  decideApproval: (id: string, body: { decision: 'granted' | 'denied'; reason?: string }) =>
    request<{ approval: Approval; session: { id: string; state: SessionState } }>(
      `/approvals/${id}/decide`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  resumeSession: (id: string) =>
    request<{ sessionId: string; state: SessionState; resumed: boolean; errorCode: string | null }>(
      `/sessions/${id}/resume`,
      { method: 'POST' },
    ),

  resolveManualReview: (
    id: string,
    input: { resolution: 'retry' | 'accept' | 'fail' | 'block'; reason: string },
  ) =>
    request<{ session: SessionSummary; resolution: string }>(`/sessions/${id}/review`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  runSession: (id: string) =>
    request<{ sessionId: string; state: SessionState; steps: number }>(`/sessions/${id}/run`, {
      method: 'POST',
    }),

  scanRecovery: () => request<{ summary: Record<string, number>; findings: RecoveryFinding[] }>('/recovery'),

  runRecovery: (execute: boolean) =>
    request<{
      execute: boolean
      summary: Record<string, number>
      applied: { sessionId: string; action: string; detail: string }[]
      resumed: { sessionId: string; state: string; errorCode: string | null }[]
      errors: { sessionId: string; message: string }[]
    }>('/recovery', { method: 'POST', body: JSON.stringify({ execute }) }),

  /** 发起发布：后端会先渲染出文件，再把文件名与摘要绑进审批。 */
  requestPublish: (
    reportId: string,
    body: { recipients: string[]; channel: 'email' | 'im' | 'portal'; format: PublishFormat },
  ) =>
    request<{
      approval: Approval
      toolCallId: string
      artifact: { format: string; fileName: string; sizeBytes: number; sha256: string }
      recipients: string[]
      warnings: string[]
      message: string
    }>(`/reports/${reportId}/publish`, { method: 'POST', body: JSON.stringify(body) }),

  /** 确认并执行发布（执行前会重新核对接收人、格式与文件字节）。 */
  confirmPublish: (approvalId: string) =>
    request<{
      status: 'pending' | 'published' | 'already-published'
      approvalId?: string
      receiptId?: string
      message?: string
      receipt?: {
        receiptId: string
        format: string
        fileName: string
        sha256: string
        sizeBytes: number
        deliveredPath: string
        recipients: string[]
        publishedAt: string
        deduplicated: boolean
      }
      report?: { reportId: string; status: string }
    }>(`/approvals/${approvalId}/confirm`, { method: 'POST' }),

  /** 发布结果未知时查回执。这个方法永远不会重发。 */
  reconcilePublish: (sessionId: string) =>
    request<{
      status: 'already-published' | 'reconciled' | 'not-delivered' | 'unknown'
      receiptId?: string
      receipt?: { receiptId: string; publishedAt: string }
      message?: string
    }>(`/sessions/${sessionId}/reconcile`, { method: 'POST' }),

  listSources: () => request<SourceInfo[]>('/sources'),
}
