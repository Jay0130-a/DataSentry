import { ErrorCode, isDataSentryError } from '@datasentry/core'
import type { FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.WORKSPACE_NOT_FOUND]: 404,
  [ErrorCode.SESSION_NOT_FOUND]: 404,
  [ErrorCode.SKILL_NOT_FOUND]: 404,
  [ErrorCode.REPORT_NOT_FOUND]: 404,
  [ErrorCode.APPROVAL_NOT_FOUND]: 404,
  [ErrorCode.SOURCE_CONFIG_INVALID]: 500,
  [ErrorCode.TOOL_NOT_REGISTERED]: 400,
  [ErrorCode.SOURCE_NOT_ACTIVE]: 403,
  [ErrorCode.SOURCE_DISABLED]: 403,
  [ErrorCode.WORKSPACE_BOUNDARY_VIOLATION]: 403,
  [ErrorCode.GUIDE_NOT_READ]: 409,
  [ErrorCode.SCHEMA_INVALID]: 400,
  [ErrorCode.SENSITIVE_REQUIRES_APPROVAL]: 403,
  [ErrorCode.APPROVAL_REQUIRED]: 409,
  // 审批相关：409 表示「状态/绑定对不上，需要重新走一遍」，
  // 403 表示「明确不允许」——「已批准但被改过」属于前者，要重批而不是判死刑。
  [ErrorCode.APPROVAL_INVALID]: 409,
  [ErrorCode.APPROVAL_EXPIRED]: 409,
  [ErrorCode.APPROVAL_PARAMS_DRIFT]: 409,
  [ErrorCode.APPROVAL_DENIED]: 403,
  // 「没资格批」与「不能批自己的」都是明确不允许，不是状态冲突。
  [ErrorCode.APPROVAL_NOT_AUTHORIZED]: 403,
  [ErrorCode.APPROVAL_SELF_DENIED]: 403,
  // 缺策略是配置问题，不是调用方的错。
  [ErrorCode.APPROVAL_POLICY_MISSING]: 500,
  [ErrorCode.CREDENTIAL_MISSING]: 502,
  [ErrorCode.RECEIPT_UNKNOWN]: 502,
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.ILLEGAL_STATE_TRANSITION]: 409,
  [ErrorCode.STATE_VERSION_CONFLICT]: 409,
  [ErrorCode.PUBLISH_CONFIRMATION_PENDING]: 409,
  // 401 与 403 必须分开：401 是「先登录」，403 是「登录了也不行」。
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.AUTH_INVALID_CREDENTIALS]: 401,
  [ErrorCode.AUTH_RATE_LIMITED]: 429,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.AUTH_CONFIG_INVALID]: 500,
}

/**
 * 错误响应统一带上 `code`。
 *
 * 这个字段是给调用方和回归脚本用的：`403 WORKSPACE_BOUNDARY_VIOLATION` 和
 * `403 SOURCE_NOT_ACTIVE` 都是 403，但一个是越权、一个是没激活，
 * 排障方向完全不同，不能都退化成一句「Forbidden」。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (isDataSentryError(error)) {
      const status = STATUS_BY_CODE[error.code] ?? 400
      return reply.code(status).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
    }

    // 路由层用 Zod 校验请求体；它是调用方的输入错误，不能落成 500。
    if (error instanceof ZodError) {
      const first = error.issues[0]
      return reply.code(400).send({
        error: {
          code: ErrorCode.SCHEMA_INVALID,
          message: first
            ? `${first.path.join('.') || '请求体'}：${first.message}`
            : '请求参数不合法',
          details: { issues: error.issues },
        },
      })
    }

    const fallback = error as { statusCode?: number; message?: string }
    const status = fallback.statusCode ?? 500
    request.log.error({ err: error }, '未处理的请求错误')
    return reply.code(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
        message: fallback.message ?? '未知错误',
      },
    })
  })

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `没有这个路由：${request.method} ${request.url}`,
      },
    }),
  )
}
