/**
 * 统一错误码。权限、审批、状态恢复是正确性核心，因此每一类拒绝都必须有
 * 稳定的错误码，供 PreToolUse 结果、事件轨迹和回归样本断言使用。
 */
export const ErrorCode = {
  // —— 工具与 Source 边界（FR-01 / FR-03）
  TOOL_NOT_REGISTERED: 'TOOL_NOT_REGISTERED',
  SOURCE_NOT_ACTIVE: 'SOURCE_NOT_ACTIVE',
  SOURCE_DISABLED: 'SOURCE_DISABLED',
  WORKSPACE_BOUNDARY_VIOLATION: 'WORKSPACE_BOUNDARY_VIOLATION',
  GUIDE_NOT_READ: 'GUIDE_NOT_READ',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  SENSITIVE_REQUIRES_APPROVAL: 'SENSITIVE_REQUIRES_APPROVAL',

  // —— 审批（M2）
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_INVALID: 'APPROVAL_INVALID',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_PARAMS_DRIFT: 'APPROVAL_PARAMS_DRIFT',
  APPROVAL_DENIED: 'APPROVAL_DENIED',

  // —— 工具执行
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_RESULT_SCHEMA_INVALID: 'TOOL_RESULT_SCHEMA_INVALID',
  /** 执行到一半进程挂了，这条调用的结果是未知的。 */
  EXECUTION_INTERRUPTED: 'EXECUTION_INTERRUPTED',

  // —— 模型
  /** 调用模型失败（网络、认证、限流、输出截断等）。 */
  MODEL_CALL_FAILED: 'MODEL_CALL_FAILED',
  /** 模型拒答。 */
  MODEL_REFUSED: 'MODEL_REFUSED',
  /** 模型配置有问题（缺密钥、provider 不认识等）。 */
  MODEL_CONFIG_INVALID: 'MODEL_CONFIG_INVALID',

  // —— 状态与恢复（FR-04）
  ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION',
  STATE_VERSION_CONFLICT: 'STATE_VERSION_CONFLICT',

  // —— 配置与查找
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  /** 报表 / 审批按 id 找不到。与「状态不对」分开：一个是不存在，一个是存在但不可用。 */
  REPORT_NOT_FOUND: 'REPORT_NOT_FOUND',
  APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  SOURCE_CONFIG_INVALID: 'SOURCE_CONFIG_INVALID',
  CREDENTIAL_MISSING: 'CREDENTIAL_MISSING',

  // —— 需求理解
  /** 需求里识别不到会计期间。 */
  REQUEST_PERIOD_MISSING: 'REQUEST_PERIOD_MISSING',
  /** 需求里出现了多个互相矛盾的期间。 */
  REQUEST_PERIOD_AMBIGUOUS: 'REQUEST_PERIOD_AMBIGUOUS',
  /** 需求文本与显式输入说的是不同的期间。 */
  REQUEST_PERIOD_CONFLICT: 'REQUEST_PERIOD_CONFLICT',

  // —— 报表与发布（FR-06）
  METRIC_INPUT_INCOMPLETE: 'METRIC_INPUT_INCOMPLETE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PUBLISH_NOT_CONFIRMED: 'PUBLISH_NOT_CONFIRMED',
  /** 审批是「发布确认」，执行入口是 confirm-publish，不能被当作取数审批重放。 */
  PUBLISH_CONFIRMATION_PENDING: 'PUBLISH_CONFIRMATION_PENDING',

  // —— 身份与权限
  /** 没有登录，或会话已过期/被吊销。区分于 FORBIDDEN：先登录，再谈权限。 */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** 已登录，但当前角色不允许这个动作。 */
  FORBIDDEN: 'FORBIDDEN',
  /** 用户名或口令不对——**不区分是哪一个**，避免把账号是否存在告诉调用方。 */
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  /** 生产环境没有提供初始口令：宁可启动失败，也不要悄悄用默认口令。 */
  AUTH_CONFIG_INVALID: 'AUTH_CONFIG_INVALID',

  // —— 审批资格（谁能批）
  /** 当前身份不具备批准该类动作的资格。 */
  APPROVAL_NOT_AUTHORIZED: 'APPROVAL_NOT_AUTHORIZED',
  /** 不能批准自己发起的任务（职责分离）。 */
  APPROVAL_SELF_DENIED: 'APPROVAL_SELF_DENIED',
  /** Workspace 没有配置审批策略：没人有资格批，而不是谁都能批。 */
  APPROVAL_POLICY_MISSING: 'APPROVAL_POLICY_MISSING',
  RECEIPT_UNKNOWN: 'RECEIPT_UNKNOWN',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export class DataSentryError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DataSentryError'
    this.code = code
    this.details = details
  }

  toJSON(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export function isDataSentryError(err: unknown): err is DataSentryError {
  return err instanceof DataSentryError
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>): never {
  throw new DataSentryError(code, message, details)
}
