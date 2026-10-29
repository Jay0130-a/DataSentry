import { ErrorCode } from '@datasentry/core'

export type ApprovalCategory = 'confidential' | 'publish'

export interface ApprovalPolicyLike {
  confidential?: readonly string[]
  publish?: readonly string[]
}

export interface ApprovalActor {
  userId: string
  roles: readonly string[]
}

export interface AuthorityInput {
  category: ApprovalCategory
  policy: ApprovalPolicyLike | undefined
  segregationOfDuties: boolean
  /** 发起人；CLI/回归发起的任务没有发起人。 */
  sessionCreatedBy: string | null
  actor: ApprovalActor
}

export type AuthorityVerdict =
  | { ok: true }
  | { ok: false; code: ErrorCode; reason: string; requiredRoles: string[] }

/** 审批类别由审批类型决定：发布确认单独一档，其余都是工具调用审批。 */
export function approvalCategoryOf(kind: 'tool-call' | 'publish'): ApprovalCategory {
  return kind === 'publish' ? 'publish' : 'confidential'
}

/**
 * 审批资格判定（谁能批）。
 *
 * 这一步回答的不是「这个调用被批准了吗」，而是「**这个人**有资格批吗」。
 * 前端把按钮藏起来只是提示，真正的边界在这里。
 *
 * 三条规则，按序短路：
 * 1. **没有策略 = 没人能批**。缺少配置时宁可停住，也不要把「谁都能点同意」
 *    当成默认值——那等于把审批变成一个装饰。
 * 2. **先看资格，再看职责分离**。没有资格的人，报「不能批自己的任务」
 *    会把人引到错误的方向；真正的原因是他本来就不该批。
 * 3. **职责分离**：发起人不能批准自己发起的任务。
 */
export function evaluateApprovalAuthority(input: AuthorityInput): AuthorityVerdict {
  const required = input.policy?.[input.category] ?? []

  if (!input.policy || required.length === 0) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_POLICY_MISSING,
      reason:
        `Workspace 没有配置「${input.category}」的审批角色，任何人都不能批准。` +
        `请先在 workspace.json 的 approvalPolicy 里声明。`,
      requiredRoles: [],
    }
  }

  const authorized = input.actor.roles.some((role) => required.includes(role))
  if (!authorized) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_NOT_AUTHORIZED,
      reason: `批准「${input.category}」需要角色 ${required.join(' / ')}，当前身份不具备`,
      requiredRoles: [...required],
    }
  }

  if (input.segregationOfDuties && input.sessionCreatedBy === input.actor.userId) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_SELF_DENIED,
      reason: '职责分离：不能批准自己发起的任务',
      requiredRoles: [...required],
    }
  }

  return { ok: true }
}
