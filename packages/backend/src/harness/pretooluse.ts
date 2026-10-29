import {
  ErrorCode,
  validateWithJsonSchema,
  type Approval,
  type PermissionMode,
} from '@datasentry/core'
import type { RegisteredTool } from '../sources/builder.ts'
import { evaluateApproval } from '../runtime/approval-store.ts'
import { evaluatePermissionMode, type PermissionEffect } from './permission-mode.ts'

export interface PreToolUseContext {
  toolName: string
  args: Record<string, unknown>
  /** 注册表里的工具；未注册时为 undefined。 */
  tool: RegisteredTool | undefined
  /**
   * 本次调用真正作用在哪个 Source 上。
   *
   * 对 Source 工具就是它自己；对内置的 `read_source_guide` 则是参数里指定的**目标**
   * Source——否则「读别人的 guide」就成了绕过 Workspace 边界的一条小路：
   * guide 里写着参数范围与结果契约，它本身就是该数据源的信息。
   * 对其它内置工具为 null，表示不涉及任何 Source。
   */
  subjectSourceSlug: string | null
  /** 当前 Workspace 允许的 Source slug —— 访问边界。 */
  workspaceSourceSlugs: readonly string[]
  /** 本次 Session 预启用的 Source slug（来自 Skill 的 requiredSources）。 */
  activeSourceSlugs: readonly string[]
  guideRead: (sourceSlug: string) => boolean
  permissionMode: PermissionMode
  /** 本次调用的参数摘要；审批绑定校验用它。 */
  paramsHash: string
  /**
   * 悬挂在本次调用上的审批记录（按 toolCallId 关联）。
   *
   * 有审批不代表放行——`evaluateApproval` 会逐项核对绑定。绑定不符时
   * 报的是「审批失效」而不是「需要审批」：这两者对审批人的含义完全不同，
   * 前者说明有人试图改参数蒙混过关，值得单独看一眼。
   */
  approval?: Approval | undefined
  /**
   * 本次调用是否来自**已获人工确认的发布入口**（`confirmPublish`）。
   *
   * 正式发布只能由 `confirmPublish` 执行：它会在投递前重新核对草稿版本、
   * 接收人摘要与文件字节。模型直接调用发布工具时这里为 false，即使审批链
   * 后面看起来「可以批」，也不该让 Agent 走到投递。
   */
  allowPublish?: boolean
}

export interface PreToolUseResult {
  effect: PermissionEffect
  code?: string
  reason: string
  /** 哪一项检查做出的判定，便于排障与回归断言。 */
  checkedBy: string
}

export interface PreToolUseCheck {
  id: string
  /** 返回 null 表示本项放行，交给下一项。 */
  run: (ctx: PreToolUseContext) => PreToolUseResult | null
}

/** 检查 1：工具必须在注册表里。 */
const toolRegistered: PreToolUseCheck = {
  id: 'tool-registered',
  run(ctx) {
    if (ctx.tool) return null
    return {
      effect: 'deny',
      code: ErrorCode.TOOL_NOT_REGISTERED,
      reason: `工具 "${ctx.toolName}" 未注册`,
      checkedBy: 'tool-registered',
    }
  },
}

/**
 * 检查 2：Workspace 边界。
 *
 * 刻意排在「Source 已激活」**之前**：跨 Workspace 的 Source 同时也一定没被激活，
 * 若先查激活状态，越权访问会被报成 `SOURCE_NOT_ACTIVE`——错误码指错了原因，
 * 排障的人会去查 skill 配置，而真正的问题是没有权限。
 */
const workspaceBoundary: PreToolUseCheck = {
  id: 'workspace-boundary',
  run(ctx) {
    const subject = ctx.subjectSourceSlug
    if (!subject) return null
    if (ctx.workspaceSourceSlugs.includes(subject)) return null

    return {
      effect: 'deny',
      code: ErrorCode.WORKSPACE_BOUNDARY_VIOLATION,
      reason: `Source "${subject}" 不属于当前 Workspace（允许：${ctx.workspaceSourceSlugs.join(', ') || '无'}）`,
      checkedBy: 'workspace-boundary',
    }
  },
}

/** 检查 3：Source 必须已被本次 Session 激活。 */
const sourceActive: PreToolUseCheck = {
  id: 'source-active',
  run(ctx) {
    const subject = ctx.subjectSourceSlug
    if (!subject) return null
    if (ctx.activeSourceSlugs.includes(subject)) return null

    return {
      effect: 'deny',
      code: ErrorCode.SOURCE_NOT_ACTIVE,
      reason: `Source "${subject}" 未在本次 Session 中激活（已激活：${ctx.activeSourceSlugs.join(', ') || '无'}）`,
      checkedBy: 'source-active',
    }
  },
}

/**
 * 检查 4：调用前必须读过该 Source 的 guide（PRD FR-01.5）。
 *
 * 只对 Source 工具生效——读 guide 这个动作本身当然不能要求先读过 guide。
 */
const guideRead: PreToolUseCheck = {
  id: 'guide-read',
  run(ctx) {
    const tool = ctx.tool
    if (!tool || tool.kind !== 'source' || !tool.requiresGuide) return null
    if (!ctx.subjectSourceSlug) return null
    if (ctx.guideRead(ctx.subjectSourceSlug)) return null

    return {
      effect: 'deny',
      code: ErrorCode.GUIDE_NOT_READ,
      reason: `调用 "${ctx.subjectSourceSlug}" 的工具前必须先读它的 guide`,
      checkedBy: 'guide-read',
    }
  },
}

/** 检查 5：参数必须过 Schema。在执行前拦，不等到执行报错。 */
const paramsSchema: PreToolUseCheck = {
  id: 'params-schema',
  run(ctx) {
    const tool = ctx.tool
    if (!tool) return null

    const outcome = validateWithJsonSchema(tool.paramsSchema, ctx.args)
    if (outcome.ok) return null

    return {
      effect: 'deny',
      code: ErrorCode.SCHEMA_INVALID,
      reason: `参数不符合 ${tool.name} 的契约：${outcome.message}`,
      checkedBy: 'params-schema',
    }
  },
}

/**
 * 检查 6：发布必须由 `confirmPublish` 执行，Agent 不得直接投递（FR-03.4 / FR-06.2）。
 *
 * 这条排在审批有效性**之前**：即便数据库里挂着一条「已批准」的调用，
 * 只要它不是从发布确认入口进来的，就不该执行。发布的前置校验（接收人白名单、
 * 草稿状态、文件摘要）全在 `requestPublish`/`confirmPublish` 里，绕过入口
 * 等于把这一整套校验一起绕过。
 */
const publishRequiresConfirmation: PreToolUseCheck = {
  id: 'publish-requires-confirmation',
  run(ctx) {
    const tool = ctx.tool
    if (!tool || tool.sideEffect !== 'publish') return null
    // 入口标记必须与审批记录本身绑定：只看调用方传的布尔值，
    // 等于把「能不能发」重新交给了一个可以被误用的参数。
    if (ctx.allowPublish === true && ctx.approval?.kind === 'publish') return null

    return {
      effect: 'deny',
      code: ErrorCode.PUBLISH_NOT_CONFIRMED,
      reason: `正式发布只能通过「发起发布 → 人工确认 → 确认投递」执行，Agent 不能直接调用 ${tool.name}`,
      checkedBy: 'publish-requires-confirmation',
    }
  },
}

/**
 * 检查 7：审批有效性（PRD FR-03.3）。
 *
 * 它排在敏感级别判定**之前**，因为它们回答的是同一个问题的两面：
 * 「这个动作需不需要审批」和「该动作身上的审批还算数吗」。
 * 审批有效就直接放行，无效就明确报出失效原因，两者都不该再落到「需要审批」上——
 * 那会让一条已经批准的调用看起来像从没批过。
 */
const approvalValidity: PreToolUseCheck = {
  id: 'approval-validity',
  run(ctx) {
    const tool = ctx.tool
    const approval = ctx.approval
    if (!tool || !approval) return null

    const verdict = evaluateApproval(approval, {
      toolName: tool.name,
      toolVersion: tool.toolVersion,
      paramsHash: ctx.paramsHash,
    })

    if (verdict.ok) {
      return {
        effect: 'allow',
        reason: `已获审批 ${approval.id}（审批人 ${approval.approver ?? '未记录'}）放行`,
        checkedBy: 'approval-validity',
      }
    }

    return {
      effect: 'deny',
      code: verdict.code,
      reason: verdict.reason,
      checkedBy: 'approval-validity',
    }
  },
}

/** 检查 8：敏感级别 × Permission Mode。返回 `ask` 时由调用方转入审批流。 */
const sensitivity: PreToolUseCheck = {
  id: 'sensitivity',
  run(ctx) {
    const tool = ctx.tool
    if (!tool || tool.kind !== 'source') return null

    const verdict = evaluatePermissionMode(tool, ctx.permissionMode)
    if (verdict.effect === 'allow') return null

    return {
      effect: verdict.effect,
      ...(verdict.code !== undefined ? { code: verdict.code } : {}),
      reason: verdict.reason,
      checkedBy: 'sensitivity',
    }
  },
}

/**
 * PreToolUse 检查链（PRD FR-03.2）。
 *
 * 数组形式是刻意的：M4 还要追加「发布确认绑定」检查，只需往数组里插一项，
 * 调用方不用改。每一项只回答「我拦不拦」，不关心前面的检查做了什么。
 */
export const PRE_TOOL_USE_CHECKS: readonly PreToolUseCheck[] = [
  toolRegistered,
  workspaceBoundary,
  sourceActive,
  guideRead,
  paramsSchema,
  publishRequiresConfirmation,
  approvalValidity,
  sensitivity,
]

/** 按顺序执行检查链，第一项给出非放行结论的即终止。 */
export function evaluatePreToolUse(ctx: PreToolUseContext): PreToolUseResult {
  for (const check of PRE_TOOL_USE_CHECKS) {
    const verdict = check.run(ctx)
    if (verdict) return verdict
  }
  return {
    effect: 'allow',
    reason: '全部检查通过',
    checkedBy: 'none',
  }
}
