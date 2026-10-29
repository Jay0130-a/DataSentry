import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type {
  Conflict,
  MetricValue,
  PermissionMode,
  SessionState,
  SourceType,
  AuthType,
  ToolCallStatus,
  ApprovalStatus,
  ReportStatus,
} from '@datasentry/core'

/**
 * 状态库表结构（PRD §7）。
 *
 * TS 侧用 camelCase，DB 侧用 snake_case——这点映射成本换来的是
 * SQL 里可读的列名和 TS 里一致的命名。
 *
 * M1 只会写 workspace / session / source / tool_call / checkpoint / event 六张，
 * approval 与 report 一次建好，M2/M4 直接落数据，不返工。
 */

export const workspaces = sqliteTable('workspace', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Source slug 列表：Workspace 的访问边界。 */
  sources: text('sources', { mode: 'json' }).$type<string[]>().notNull(),
  skills: text('skills', { mode: 'json' }).$type<string[]>().notNull(),
  defaultPermissionMode: text('default_permission_mode').$type<PermissionMode>().notNull(),
  ruleVersion: text('rule_version').notNull(),
  currency: text('currency').notNull(),
  timezone: text('timezone').notNull(),
  createdAt: text('created_at').notNull(),
})

export const sessions = sqliteTable('session', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  /** 发起人账号；历史数据与 CLI 发起的任务为 null。只用于审计，不参与鉴权。 */
  createdBy: text('created_by'),
  state: text('state').$type<SessionState>().notNull(),
  step: integer('step').notNull().default(0),
  /** 乐观锁：每次状态更新 +1，旧执行器拿着过期版本号写不进去。 */
  stateVersion: integer('state_version').notNull().default(0),
  skillVersion: text('skill_version').notNull(),
  inputVersion: text('input_version').notNull(),
  traceId: text('trace_id').notNull(),
  skillName: text('skill_name').notNull(),
  request: text('request').notNull(),
  input: text('input', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const sources = sqliteTable('source', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  slug: text('slug').notNull(),
  type: text('type').$type<SourceType>().notNull(),
  configRef: text('config_ref').notNull(),
  guideRef: text('guide_ref').notNull(),
  authType: text('auth_type').$type<AuthType>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  version: text('version').notNull(),
  createdAt: text('created_at').notNull(),
})

export const skills = sqliteTable('skill', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  requiredSources: text('required_sources', { mode: 'json' }).$type<string[]>().notNull(),
  version: text('version').notNull(),
  stopRules: text('stop_rules', { mode: 'json' }).$type<string[]>().notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
})

export const toolCalls = sqliteTable('tool_call', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  /** 单调递增的执行序号，恢复时靠它还原顺序。 */
  step: integer('step').notNull().default(0),
  toolName: text('tool_name').notNull(),
  sourceSlug: text('source_slug').notNull(),
  paramsHash: text('params_hash').notNull(),
  toolVersion: text('tool_version').notNull(),
  status: text('status').$type<ToolCallStatus>().notNull(),
  args: text('args', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  resultRef: text('result_ref'),
  denyCode: text('deny_code'),
  denyReason: text('deny_reason'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
})

export const approvals = sqliteTable('approval', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  toolCallId: text('tool_call_id').notNull(),
  approver: text('approver'),
  toolName: text('tool_name').notNull(),
  toolVersion: text('tool_version').notNull(),
  paramsHash: text('params_hash').notNull(),
  kind: text('kind').$type<'tool-call' | 'publish'>().notNull(),
  draftVersion: text('draft_version'),
  recipientsHash: text('recipients_hash'),
  status: text('status').$type<ApprovalStatus>().notNull(),
  reason: text('reason'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
  decidedAt: text('decided_at'),
})

export const checkpoints = sqliteTable('checkpoint', {
  sessionId: text('session_id').notNull(),
  step: integer('step').notNull(),
  stateVersion: integer('state_version').notNull(),
  inputVersion: text('input_version').notNull(),
  outputRef: text('output_ref'),
  approvalRef: text('approval_ref'),
  state: text('state').$type<SessionState>().notNull(),
  createdAt: text('created_at').notNull(),
})

export const events = sqliteTable('event', {
  eventId: text('event_id').primaryKey(),
  sessionId: text('session_id').notNull(),
  traceId: text('trace_id').notNull(),
  seq: integer('seq').notNull(),
  eventType: text('event_type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  timestamp: text('timestamp').notNull(),
})

export const reports = sqliteTable('report', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  draftVersion: text('draft_version').notNull(),
  status: text('status').$type<ReportStatus>().notNull(),
  ruleVersion: text('rule_version').notNull(),
  metrics: text('metrics', { mode: 'json' }).$type<MetricValue[]>().notNull(),
  conflicts: text('conflicts', { mode: 'json' }).$type<Conflict[]>().notNull(),
  resultRefs: text('result_refs', { mode: 'json' }).$type<string[]>().notNull(),
  dataVersions: text('data_versions', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  recipientsHash: text('recipients_hash'),
  receiptId: text('receipt_id'),
  artifactPath: text('artifact_path'),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 角色决定能看到哪些页面/接口。登录接入前只有这两种，够用且可断言。 */
export type UserRole = 'analyst' | 'admin'

/** 账号。口令只存 scrypt 摘要，登录会话只存令牌摘要。 */
export const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role').$type<UserRole>().notNull(),
  passwordHash: text('password_hash').notNull(),
  /** 审批角色。Workspace 的 approvalPolicy 里写的角色名，指的就是这里的值。 */
  approverRoles: text('approver_roles', { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default([]),
  disabled: integer('disabled').notNull().default(0),
  createdAt: text('created_at').notNull(),
})

export const authSessions = sqliteTable('auth_session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  revokedAt: text('revoked_at'),
  userAgent: text('user_agent'),
})

export const workspaceMembers = sqliteTable('workspace_member', {
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  workspaceId: text('workspace_id').notNull(),
  createdAt: text('created_at').notNull(),
})

/** 登录审计：每次登录成功/失败与登出都追加一条。 */
export const authAudit = sqliteTable('auth_audit', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  userId: text('user_id'),
  username: text('username').notNull(),
  at: text('at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  reason: text('reason'),
})

export const ALL_TABLES = {
  workspaces,
  sessions,
  sources,
  skills,
  toolCalls,
  approvals,
  checkpoints,
  events,
  reports,
  users,
  authSessions,
  workspaceMembers,
  authAudit,
} as const
