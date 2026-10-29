import { describe, expect, it } from 'vitest'
import { buildToolUrl } from '@datasentry/backend/sources/transports/http.ts'

describe('HTTP 工具 URL 拼接', () => {
  it('保留 baseUrl 的路径前缀', () => {
    expect(buildToolUrl('https://host/api/v1', '/tools/{tool}', 'revenue')).toBe(
      'https://host/api/v1/tools/revenue',
    )
  })

  it('baseUrl 结尾带斜杠时不产生双斜杠', () => {
    expect(buildToolUrl('https://host/api/v1/', '/tools/{tool}', 'revenue')).toBe(
      'https://host/api/v1/tools/revenue',
    )
  })

  it('baseUrl 没有路径时行为不变', () => {
    expect(buildToolUrl('https://host', '/tools/{tool}', 'revenue')).toBe(
      'https://host/tools/revenue',
    )
  })

  it('toolPath 不带前导斜杠也能拼', () => {
    expect(buildToolUrl('https://host/api', 'tools/{tool}', 'revenue')).toBe(
      'https://host/api/tools/revenue',
    )
  })

  it('绝对 URL 的 toolPath 优先于 baseUrl', () => {
    expect(buildToolUrl('https://host/api', 'https://erp.internal/tools/{tool}', 'revenue')).toBe(
      'https://erp.internal/tools/revenue',
    )
  })

  it('保留 baseUrl 里的 userinfo', () => {
    expect(buildToolUrl('https://user:pass@host/api', '/tools/{tool}', 'revenue')).toBe(
      'https://user:pass@host/api/tools/revenue',
    )
  })
})
