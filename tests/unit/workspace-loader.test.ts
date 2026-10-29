import { describe, expect, it } from 'vitest'
import { dataPaths, ErrorCode, isDataSentryError } from '@datasentry/core'
import { loadWorkspace } from '@datasentry/backend/workspace/loader.ts'

describe('Workspace 加载边界', () => {
  it('正常引用可以加载', () => {
    const workspace = loadWorkspace('group-finance', dataPaths())
    expect(workspace.id).toBe('group-finance')
  })

  it('拒绝 ../ 路径穿越', () => {
    try {
      loadWorkspace('../group-finance', dataPaths())
      throw new Error('本应拒绝路径穿越')
    } catch (err) {
      expect(isDataSentryError(err)).toBe(true)
      expect((err as { code: ErrorCode }).code).toBe(ErrorCode.WORKSPACE_NOT_FOUND)
    }
  })

  it('拒绝带路径分隔符的引用', () => {
    for (const ref of ['group-finance/..', '..', '.']) {
      expect(() => loadWorkspace(ref, dataPaths())).toThrowError(/非法的 Workspace 引用/)
    }
  })
})
