import { describe, expect, it } from 'vitest'
import { workspaceSchema } from '@datasentry/core'

const base = {
  id: 'ws',
  name: '测试 Workspace',
  sources: [],
  skills: [],
  defaultPermissionMode: 'ask' as const,
  ruleVersion: 'r1',
  currency: 'CNY',
  timezone: 'Asia/Shanghai',
  createdAt: new Date().toISOString(),
}

describe('Workspace 配置校验', () => {
  it('合法时区通过', () => {
    expect(workspaceSchema.safeParse(base).success).toBe(true)
  })

  it('拼错的时区在配置边界就拒绝，而不是运行时退回 UTC', () => {
    const parsed = workspaceSchema.safeParse({ ...base, timezone: 'Asia/Shangai' })
    expect(parsed.success).toBe(false)
  })

  it('IM 目标键不能只靠大小写区分', () => {
    const parsed = workspaceSchema.safeParse({
      ...base,
      imTargets: {
        'Board-Room': { credentialKey: 'A' },
        'board-room': { credentialKey: 'B' },
      },
    })
    expect(parsed.success).toBe(false)
  })

  it('IM 目标键不能带首尾空白', () => {
    const parsed = workspaceSchema.safeParse({
      ...base,
      imTargets: { ' board-room ': { credentialKey: 'A' } },
    })
    expect(parsed.success).toBe(false)
  })
})
