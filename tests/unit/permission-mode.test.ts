import { describe, expect, it } from 'vitest'
import { ErrorCode, PermissionMode, Sensitivity, SideEffect } from '@datasentry/core'
import { evaluatePermissionMode } from '@datasentry/backend/harness/permission-mode.ts'
import type { RegisteredTool } from '@datasentry/backend/sources/builder.ts'

function tool(overrides: Partial<RegisteredTool>): RegisteredTool {
  return {
    name: 'mcp__x__y',
    kind: 'source',
    sourceSlug: 'x',
    toolName: 'y',
    title: 't',
    description: 'd',
    paramsSchema: {},
    resultSchema: {},
    sensitivity: Sensitivity.INTERNAL,
    sideEffect: SideEffect.READ,
    requiresGuide: true,
    toolVersion: 'v1',
    ...overrides,
  }
}

describe('Permission Mode 判定表', () => {
  it('internal 在所有模式下都放行', () => {
    for (const mode of Object.values(PermissionMode)) {
      expect(evaluatePermissionMode(tool({ sensitivity: Sensitivity.INTERNAL }), mode).effect).toBe(
        'allow',
      )
    }
  })

  it('confidential：safe 拒绝、ask 审批、allow-all 放行', () => {
    const sensitive = tool({ sensitivity: Sensitivity.CONFIDENTIAL })
    expect(evaluatePermissionMode(sensitive, PermissionMode.SAFE)).toMatchObject({
      effect: 'deny',
      code: ErrorCode.SENSITIVE_REQUIRES_APPROVAL,
    })
    expect(evaluatePermissionMode(sensitive, PermissionMode.ASK)).toMatchObject({
      effect: 'ask',
      code: ErrorCode.APPROVAL_REQUIRED,
    })
    expect(evaluatePermissionMode(sensitive, PermissionMode.ALLOW_ALL).effect).toBe('allow')
  })

  it('发布类副作用在任何模式下都要人工二次确认', () => {
    const publish = tool({ sideEffect: SideEffect.PUBLISH, sensitivity: Sensitivity.PUBLIC })
    for (const mode of Object.values(PermissionMode)) {
      expect(evaluatePermissionMode(publish, mode)).toMatchObject({
        effect: 'ask',
        code: ErrorCode.APPROVAL_REQUIRED,
      })
    }
  })
})
