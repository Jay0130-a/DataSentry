import { describe, expect, it } from 'vitest'
import {
  ApprovalStatus,
  ErrorCode,
  hashValue,
  PermissionMode,
  Sensitivity,
  SideEffect,
  type Approval,
} from '@datasentry/core'
import { evaluatePreToolUse, type PreToolUseContext } from '@datasentry/backend/harness/pretooluse.ts'
import { subjectSourceOf } from '@datasentry/backend/harness/tool-registry.ts'
import type { RegisteredTool } from '@datasentry/backend/sources/builder.ts'

function tool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    name: 'mcp__erp__fetch_revenue',
    kind: 'source',
    sourceSlug: 'erp',
    toolName: 'fetch_revenue',
    title: '查询主营收入',
    description: '查询主营收入',
    paramsSchema: {
      type: 'object',
      properties: { period: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' } },
      required: ['period'],
      additionalProperties: false,
    },
    resultSchema: { type: 'object' },
    sensitivity: Sensitivity.INTERNAL,
    sideEffect: SideEffect.READ,
    requiresGuide: true,
    toolVersion: 'v1',
    ...overrides,
  }
}

function ctx(overrides: Partial<PreToolUseContext> = {}): PreToolUseContext {
  const resolved = overrides.tool ?? tool()
  const args = overrides.args ?? { period: '2025-09' }
  return {
    toolName: resolved.name,
    args,
    tool: resolved,
    subjectSourceSlug: subjectSourceOf(resolved, args),
    workspaceSourceSlugs: ['erp', 'finance', 'warehouse', 'excel'],
    activeSourceSlugs: ['erp', 'finance'],
    guideRead: () => true,
    permissionMode: PermissionMode.ASK,
    paramsHash: hashValue(args),
    ...overrides,
  }
}

/** 一份针对某次调用签发的审批。默认各项绑定都匹配，按需改坏某一项来测失效路径。 */
function approval(overrides: Partial<Approval> = {}): Approval {
  const target = tool()
  const args = { period: '2025-09' }
  return {
    id: 'apv_test',
    sessionId: 'sess_test',
    workspaceId: 'ws_test',
    toolCallId: 'tc_test',
    approver: '财务经理',
    toolName: target.name,
    toolVersion: target.toolVersion,
    paramsHash: hashValue(args),
    kind: 'tool-call',
    draftVersion: null,
    recipientsHash: null,
    status: ApprovalStatus.GRANTED,
    reason: null,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    decidedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('PreToolUse 检查链', () => {
  it('全部满足时放行', () => {
    const verdict = evaluatePreToolUse(ctx())
    expect(verdict.effect).toBe('allow')
    expect(verdict.checkedBy).toBe('none')
  })

  it('检查 1：未注册的工具被拒', () => {
    const verdict = evaluatePreToolUse(ctx({ tool: undefined, toolName: 'mcp__erp__drop_table' }))
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.TOOL_NOT_REGISTERED,
      checkedBy: 'tool-registered',
    })
  })

  it('检查 2：跨 Workspace 的 Source 被拒，且报的是边界违规而不是「未激活」', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: tool({ name: 'mcp__finance__fetch_expense_detail', sourceSlug: 'finance' }),
        workspaceSourceSlugs: ['erp'], // 该 Workspace 只有 erp
        activeSourceSlugs: ['erp'], // 因此也没被激活
      }),
    )
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.WORKSPACE_BOUNDARY_VIOLATION,
      checkedBy: 'workspace-boundary',
    })
    expect(verdict.reason).toContain('不属于当前 Workspace')
  })

  it('检查 3：Source 在边界内但未激活，报 SOURCE_NOT_ACTIVE', () => {
    const verdict = evaluatePreToolUse(ctx({ activeSourceSlugs: [] }))
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.SOURCE_NOT_ACTIVE,
      checkedBy: 'source-active',
    })
  })

  it('检查 4：未读 guide 时被拒', () => {
    const verdict = evaluatePreToolUse(ctx({ guideRead: () => false }))
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.GUIDE_NOT_READ,
      checkedBy: 'guide-read',
    })
  })

  it('检查 4：声明 requiresGuide=false 的工具不受 guide 约束', () => {
    const verdict = evaluatePreToolUse(ctx({ tool: tool({ requiresGuide: false }), guideRead: () => false }))
    expect(verdict.effect).toBe('allow')
  })

  it('检查 5：参数不符合 Schema 时被拒', () => {
    const verdict = evaluatePreToolUse(ctx({ args: { period: '2025/09' } }))
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.SCHEMA_INVALID,
      checkedBy: 'params-schema',
    })
  })

  it('检查 5：多余参数也被拒（additionalProperties: false）', () => {
    const verdict = evaluatePreToolUse(ctx({ args: { period: '2025-09', limit: 9999 } }))
    expect(verdict).toMatchObject({ effect: 'deny', code: ErrorCode.SCHEMA_INVALID })
  })

  it('检查 6：ask 模式下机密数据需要审批', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: tool({
          name: 'mcp__finance__fetch_expense_detail',
          sourceSlug: 'finance',
          sensitivity: Sensitivity.CONFIDENTIAL,
        }),
      }),
    )
    expect(verdict).toMatchObject({
      effect: 'ask',
      code: ErrorCode.APPROVAL_REQUIRED,
      checkedBy: 'sensitivity',
    })
  })

  it('检查 6：safe 模式下机密数据直接拒绝，permission mode 不放开前面的硬检查', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: tool({ sensitivity: Sensitivity.CONFIDENTIAL, requiresGuide: true }),
        guideRead: () => false,
        permissionMode: PermissionMode.SAFE,
      }),
    )
    // guide 检查在前，因此这里报的是 GUIDE_NOT_READ —— 说明 allow-all / safe
    // 都不能绕过业务合同
    expect(verdict.code).toBe(ErrorCode.GUIDE_NOT_READ)
  })

  it('检查按序短路：后面的违规被前面的掩盖时，报的是第一个', () => {
    const verdict = evaluatePreToolUse(
      ctx({ activeSourceSlugs: [], args: { period: 'bad' } }),
    )
    expect(verdict.checkedBy).toBe('source-active')
  })

  it('未注册的工具连 subject 都解析不出来', () => {
    expect(subjectSourceOf(undefined, {})).toBeNull()
  })

  it('内置工具本身不涉及 Source，因此跳过边界与激活检查；但仍要过参数 Schema', () => {
    const builtin = tool({
      name: 'datasentry__read_source_guide',
      kind: 'builtin',
      sourceSlug: 'datasentry',
      requiresGuide: false,
      paramsSchema: {
        type: 'object',
        properties: { sourceSlug: { type: 'string', minLength: 1 } },
        required: ['sourceSlug'],
        additionalProperties: false,
      },
    })

    const ok = evaluatePreToolUse(
      ctx({
        tool: builtin,
        args: { sourceSlug: 'erp' },
        activeSourceSlugs: ['erp'],
      }),
    )
    expect(ok.effect).toBe('allow')

    const bad = evaluatePreToolUse(
      ctx({ tool: builtin, args: { sourceSlug: 'erp' }, activeSourceSlugs: [] }),
    )
    expect(bad).toMatchObject({ effect: 'deny', code: ErrorCode.SOURCE_NOT_ACTIVE })

    const invalid = evaluatePreToolUse(ctx({ tool: builtin, args: { sourceSlug: '' } }))
    expect(invalid).toMatchObject({ effect: 'deny', code: ErrorCode.SCHEMA_INVALID })
  })

  it('读 guide 不能成为绕过 Workspace 边界的小路', () => {
    const builtin = tool({
      name: 'datasentry__read_source_guide',
      kind: 'builtin',
      sourceSlug: 'datasentry',
      requiresGuide: false,
    })

    const verdict = evaluatePreToolUse(
      ctx({
        tool: builtin,
        args: { sourceSlug: 'warehouse' },
        workspaceSourceSlugs: ['erp'], // warehouse 不在本 Workspace 内
        activeSourceSlugs: ['erp'],
        guideRead: () => false,
      }),
    )

    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.WORKSPACE_BOUNDARY_VIOLATION,
      checkedBy: 'workspace-boundary',
    })
  })
})

describe('PreToolUse · 审批有效性（M2）', () => {
  const confidential = tool({
    name: 'mcp__finance__fetch_expense_detail',
    sourceSlug: 'finance',
    sensitivity: Sensitivity.CONFIDENTIAL,
  })

  it('没有审批时，机密数据按 Permission Mode 走 ask', () => {
    const verdict = evaluatePreToolUse(ctx({ tool: confidential }))
    expect(verdict).toMatchObject({
      effect: 'ask',
      code: ErrorCode.APPROVAL_REQUIRED,
      checkedBy: 'sensitivity',
    })
  })

  it('绑定完全匹配的已批准审批直接放行，不再落到 ask', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: confidential,
        approval: approval({ toolName: confidential.name }),
      }),
    )
    expect(verdict).toMatchObject({ effect: 'allow', checkedBy: 'approval-validity' })
  })

  it('参数漂移的审批被拒——这是「批了只读查询却改成导出全量」的拦截点', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: confidential,
        approval: approval({
          toolName: confidential.name,
          paramsHash: hashValue({ period: '2025-01' }), // 批的是另一个期间
        }),
      }),
    )
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.APPROVAL_PARAMS_DRIFT,
      checkedBy: 'approval-validity',
    })
  })

  it('工具版本变化导致审批失效', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: confidential,
        approval: approval({ toolName: confidential.name, toolVersion: 'old-version' }),
      }),
    )
    expect(verdict).toMatchObject({ effect: 'deny', code: ErrorCode.APPROVAL_INVALID })
  })

  it('过期的审批被拒', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: confidential,
        approval: approval({
          toolName: confidential.name,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      }),
    )
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.APPROVAL_EXPIRED,
      checkedBy: 'approval-validity',
    })
  })

  it('未决（pending）的审批不能放行，也不能被当成「需要审批」', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: confidential,
        approval: approval({ toolName: confidential.name, status: ApprovalStatus.PENDING }),
      }),
    )
    expect(verdict).toMatchObject({ effect: 'deny', code: ErrorCode.APPROVAL_INVALID })
  })

  it('审批放行也绕不过更前面的硬检查（guide 未读照样拒绝）', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: confidential,
        guideRead: () => false,
        approval: approval({ toolName: confidential.name }),
      }),
    )
    expect(verdict).toMatchObject({ effect: 'deny', code: ErrorCode.GUIDE_NOT_READ })
  })

  it('换一个工具复用审批会被拒', () => {
    const verdict = evaluatePreToolUse(
      ctx({
        tool: confidential,
        approval: approval({ toolName: 'mcp__erp__fetch_revenue' }),
      }),
    )
    expect(verdict).toMatchObject({ effect: 'deny', code: ErrorCode.APPROVAL_INVALID })
  })
})

describe('发布只能由确认入口执行', () => {
  const publishTool = tool({
    name: 'mcp__publish__publish_report',
    sourceSlug: 'publish',
    toolName: 'publish_report',
    title: '发布报表',
    description: '发布报表',
    paramsSchema: {
      type: 'object',
      properties: { reportId: { type: 'string', minLength: 1 } },
      required: ['reportId'],
      additionalProperties: false,
    },
    sensitivity: Sensitivity.INTERNAL,
    sideEffect: SideEffect.PUBLISH,
    requiresGuide: false,
    toolVersion: 'v1',
  })
  const args = { reportId: 'rpt_test' }

  function publishContext(overrides: Partial<PreToolUseContext> = {}): PreToolUseContext {
    return ctx({
      tool: publishTool,
      args,
      toolName: publishTool.name,
      workspaceSourceSlugs: ['publish'],
      activeSourceSlugs: ['publish'],
      approval: approval({
        toolName: publishTool.name,
        paramsHash: hashValue(args),
        kind: 'publish',
      }),
      ...overrides,
    })
  }

  it('即使挂着已批准的调用，Agent 直调发布也会被拒', () => {
    const verdict = evaluatePreToolUse(publishContext())
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.PUBLISH_NOT_CONFIRMED,
      checkedBy: 'publish-requires-confirmation',
    })
  })

  it('confirmPublish 的确认入口放行', () => {
    const verdict = evaluatePreToolUse(publishContext({ allowPublish: true }))
    expect(verdict).toMatchObject({ effect: 'allow' })
  })

  it('只有入口标记、审批不是发布类时仍然拒绝', () => {
    const verdict = evaluatePreToolUse(
      publishContext({
        allowPublish: true,
        approval: approval({
          toolName: publishTool.name,
          paramsHash: hashValue(args),
          kind: 'tool-call',
        }),
      }),
    )
    expect(verdict).toMatchObject({
      effect: 'deny',
      code: ErrorCode.PUBLISH_NOT_CONFIRMED,
    })
  })
})
