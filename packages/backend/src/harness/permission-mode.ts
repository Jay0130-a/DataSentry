import { ErrorCode, PermissionMode, Sensitivity } from '@datasentry/core'
import type { RegisteredTool } from '../sources/builder.ts'

export type PermissionEffect = 'allow' | 'ask' | 'deny'

export interface PermissionVerdict {
  effect: PermissionEffect
  code?: string
  reason: string
}

/**
 * 敏感级别 × Permission Mode 的判定表（PRD FR-03.1）。
 *
 * | 敏感级别     | safe  | ask   | allow-all |
 * |--------------|-------|-------|-----------|
 * | public       | allow | allow | allow     |
 * | internal     | allow | allow | allow     |
 * | confidential | deny  | ask   | allow     |
 *
 * 两条不变量，任何模式都不放开：
 * 1. **发布类副作用**（`sideEffect: 'publish'`）在 `safe` / `ask` 下都需要审批，
 *    在 `allow-all` 下也需要——正式发布有自己的二次确认（FR-03.4 / FR-06.2）。
 * 2. `internal` 在 `safe` 下允许是刻意的：安全模式限制的是**敏感数据**，
 *    不是「所有写操作」，否则连只读取数都做不了，这个模式就没有实用价值。
 *
 * 注意：这条判定**不涉及**工具是否注册、Source 是否激活、Workspace 边界、
 * guide 是否已读——那些是 PreToolUse 链上前面的硬检查，任何模式都绕不过。
 */
export function evaluatePermissionMode(
  tool: RegisteredTool,
  mode: PermissionMode,
): PermissionVerdict {
  // 正式发布在任何模式下都走人工二次确认 — 这是业务合同，不是通用审批。
  if (tool.sideEffect === 'publish') {
    return {
      effect: 'ask',
      code: ErrorCode.APPROVAL_REQUIRED,
      reason: `正式发布需要单独的人工二次确认（当前模式 ${mode}）`,
    }
  }

  if (tool.sensitivity !== Sensitivity.CONFIDENTIAL) {
    return { effect: 'allow', reason: `敏感级别 ${tool.sensitivity} 在当前模式下放行` }
  }

  switch (mode) {
    case PermissionMode.SAFE:
      return {
        effect: 'deny',
        code: ErrorCode.SENSITIVE_REQUIRES_APPROVAL,
        reason: `安全模式不允许读取敏感数据（${tool.name}）`,
      }
    case PermissionMode.ASK:
      return {
        effect: 'ask',
        code: ErrorCode.APPROVAL_REQUIRED,
        reason: `读取敏感数据需要审批（${tool.name}）`,
      }
    case PermissionMode.ALLOW_ALL:
      return {
        effect: 'allow',
        reason: 'allow-all 模式下跳过通用审批，但不放开业务合同',
      }
  }
}
