import { describe, expect, it } from 'vitest'
import { ErrorCode } from '@datasentry/core'
import {
  approvalCategoryOf,
  evaluateApprovalAuthority,
  type AuthorityInput,
  type AuthorityVerdict,
} from '@datasentry/backend/harness/approval-authority.ts'

const POLICY = {
  confidential: ['finance-approver', 'cfo'],
  publish: ['finance-approver'],
}

function evaluate(overrides: Partial<AuthorityInput> = {}): AuthorityVerdict {
  return evaluateApprovalAuthority({
    category: 'confidential',
    policy: POLICY,
    segregationOfDuties: true,
    sessionCreatedBy: 'usr_other',
    actor: { userId: 'usr_me', roles: ['finance-approver'] },
    ...overrides,
  })
}

function codeOf(verdict: AuthorityVerdict): string | null {
  return verdict.ok ? null : verdict.code
}

describe('审批类别', () => {
  it('工具调用算 confidential，发布确认单独一档', () => {
    expect(approvalCategoryOf('tool-call')).toBe('confidential')
    expect(approvalCategoryOf('publish')).toBe('publish')
  })
})

describe('审批资格', () => {
  it('没有配置策略时谁都不能批——不是谁都能批', () => {
    const verdict = evaluate({ policy: undefined })
    expect(codeOf(verdict)).toBe(ErrorCode.APPROVAL_POLICY_MISSING)
  })

  it('策略里该类别是空列表，同样视为没有策略', () => {
    const verdict = evaluate({ policy: { confidential: [], publish: ['cfo'] } })
    expect(codeOf(verdict)).toBe(ErrorCode.APPROVAL_POLICY_MISSING)
  })

  it('角色不匹配时拒绝，并告诉调用方缺什么角色', () => {
    const verdict = evaluate({ actor: { userId: 'usr_me', roles: ['team-lead'] } })
    expect(codeOf(verdict)).toBe(ErrorCode.APPROVAL_NOT_AUTHORIZED)
    if (!verdict.ok) {
      expect(verdict.requiredRoles).toEqual(['finance-approver', 'cfo'])
      expect(verdict.reason).toContain('finance-approver')
    }
  })

  it('角色匹配即通过', () => {
    expect(evaluate().ok).toBe(true)
  })

  it('发布走 publish 那份名单', () => {
    // cfo 能批 confidential，但 publish 名单里没有 cfo
    const verdict = evaluate({
      category: 'publish',
      actor: { userId: 'usr_me', roles: ['cfo'] },
    })
    expect(codeOf(verdict)).toBe(ErrorCode.APPROVAL_NOT_AUTHORIZED)
  })
})

describe('职责分离', () => {
  it('不能批准自己发起的任务', () => {
    const verdict = evaluate({ sessionCreatedBy: 'usr_me' })
    expect(codeOf(verdict)).toBe(ErrorCode.APPROVAL_SELF_DENIED)
  })

  it('关闭职责分离后允许自批', () => {
    expect(evaluate({ sessionCreatedBy: 'usr_me', segregationOfDuties: false }).ok).toBe(true)
  })

  it('CLI/回归发起的任务没有发起人，不受职责分离影响', () => {
    expect(evaluate({ sessionCreatedBy: null }).ok).toBe(true)
  })

  it('先判资格再判职责分离：没资格的人得到的是「没资格」而不是「不能自批」', () => {
    const verdict = evaluate({
      actor: { userId: 'usr_me', roles: [] },
      sessionCreatedBy: 'usr_me',
    })
    expect(codeOf(verdict)).toBe(ErrorCode.APPROVAL_NOT_AUTHORIZED)
  })
})
