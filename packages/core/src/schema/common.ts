import { z } from 'zod'

/** ISO-8601 时间戳字符串。跨进程/跨存储保持字符串，避免时区与精度漂移。 */
export const isoTimestamp = z.string().min(1)

/** 月度周期，报表口径的基本时间单位，如 `2025-09`。 */
export const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period 需为 YYYY-MM 格式')

export const jsonObject = z.record(z.string(), z.unknown())
export const jsonValue = z.unknown()

/**
 * Permission Mode（PRD FR-03）：
 * - `safe`    只读、非敏感动作直接放行，其余阻断
 * - `ask`     敏感动作走审批（M2 主用）
 * - `allow-all` 跳过通用审批，但不放开业务合同（guide 已读、Workspace 边界、正式发布二次确认）
 */
export const PermissionMode = {
  SAFE: 'safe',
  ASK: 'ask',
  ALLOW_ALL: 'allow-all',
} as const

export const permissionModeSchema = z.enum(PermissionMode)
export type PermissionMode = (typeof PermissionMode)[keyof typeof PermissionMode]

/** Source 接入类型（PRD FR-01）。 */
export const SourceType = {
  MCP_STDIO: 'mcp-stdio',
  HTTP: 'http',
  LOCAL: 'local',
  POSTGRES: 'postgres',
} as const

export const sourceTypeSchema = z.enum(SourceType)
export type SourceType = (typeof SourceType)[keyof typeof SourceType]

/** 数据敏感级别，决定 Permission Mode 下的放行/审批/阻断。 */
export const Sensitivity = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
} as const

export const sensitivitySchema = z.enum(Sensitivity)
export type Sensitivity = (typeof Sensitivity)[keyof typeof Sensitivity]

/** 副作用级别：read 只读、write 产生变更、publish 对外发布。 */
export const SideEffect = {
  READ: 'read',
  WRITE: 'write',
  PUBLISH: 'publish',
} as const

export const sideEffectSchema = z.enum(SideEffect)
export type SideEffect = (typeof SideEffect)[keyof typeof SideEffect]

/** 取数完整性（PRD FR-01.4）。partial 需要在报表里显式标注。 */
export const Completeness = {
  FULL: 'full',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown',
} as const

export const completenessSchema = z.enum(Completeness)
export type Completeness = (typeof Completeness)[keyof typeof Completeness]

/** 认证方式。凭据本体永不进模型上下文，只在这里留类型。 */
export const AuthType = {
  NONE: 'none',
  STATIC_TOKEN: 'static-token',
  BASIC: 'basic',
} as const

export const authTypeSchema = z.enum(AuthType)
export type AuthType = (typeof AuthType)[keyof typeof AuthType]

/** 工具调用结果状态。 */
export const ToolCallStatus = {
  PENDING: 'pending',
  DENIED: 'denied',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const

export const toolCallStatusSchema = z.enum(ToolCallStatus)
export type ToolCallStatus = (typeof ToolCallStatus)[keyof typeof ToolCallStatus]

/** 审批状态（M2）。 */
export const ApprovalStatus = {
  PENDING: 'pending',
  GRANTED: 'granted',
  DENIED: 'denied',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
} as const

export const approvalStatusSchema = z.enum(ApprovalStatus)
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus]

/** 报表状态。 */
export const ReportStatus = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  PUBLISHED: 'published',
  FAILED: 'failed',
} as const

export const reportStatusSchema = z.enum(ReportStatus)
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus]

/** 工具统一命名：`mcp__{source}__{tool}`（PRD FR-01 验收标准）。 */
export const TOOL_NAME_PREFIX = 'mcp__'

export function buildToolName(sourceSlug: string, toolName: string): string {
  return `${TOOL_NAME_PREFIX}${sourceSlug}__${toolName}`
}

export interface ParsedToolName {
  sourceSlug: string
  toolName: string
}

/** 解析工具名；格式不合法返回 null，由 PreToolUse 的「工具已注册」检查拒绝。 */
export function parseToolName(fullName: string): ParsedToolName | null {
  if (!fullName.startsWith(TOOL_NAME_PREFIX)) return null
  const rest = fullName.slice(TOOL_NAME_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const sourceSlug = rest.slice(0, sep)
  const toolName = rest.slice(sep + 2)
  if (!toolName) return null
  return { sourceSlug, toolName }
}
