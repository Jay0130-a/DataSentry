import { describe, expect, it } from 'vitest'
import { readCookie } from '@datasentry/backend/server/cookies.ts'

describe('Cookie 解析', () => {
  it('读取指定 Cookie', () => {
    expect(readCookie('a=1; ds_session=token-123; b=2', 'ds_session')).toBe('token-123')
  })

  it('缺少 Cookie 时返回 null', () => {
    expect(readCookie(undefined, 'ds_session')).toBeNull()
    expect(readCookie('a=1', 'ds_session')).toBeNull()
  })

  it('畸形百分号编码不会抛异常，按未登录处理', () => {
    expect(readCookie('ds_session=%', 'ds_session')).toBeNull()
  })
})
