import { describe, expect, it } from 'vitest'
import { canonicalJson, hashValue } from '@datasentry/core'

describe('稳定哈希', () => {
  it('键顺序不影响结果', () => {
    const a = { period: '2025-09', buCodes: ['BU-EAST'], nested: { x: 1, y: 2 } }
    const b = { nested: { y: 2, x: 1 }, buCodes: ['BU-EAST'], period: '2025-09' }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(hashValue(a)).toBe(hashValue(b))
  })

  it('数组顺序影响结果（顺序是语义的一部分）', () => {
    expect(hashValue({ buCodes: ['A', 'B'] })).not.toBe(hashValue({ buCodes: ['B', 'A'] }))
  })

  it('undefined 字段被丢弃，所以「没传」与「传 undefined」等价', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('参数变化必然改变摘要——审批漂移检测依赖这一点', () => {
    const base = { period: '2025-09', category: '差旅费' }
    expect(hashValue(base)).not.toBe(hashValue({ ...base, category: '市场推广费' }))
    expect(hashValue(base)).not.toBe(hashValue({ ...base, period: '2025-10' }))
  })

  it('拒绝非有限数值，避免 NaN 悄悄变成 null', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrowError(/非有限数值/)
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrowError(/非有限数值/)
  })

  it('拒绝循环引用', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => canonicalJson(cyclic)).toThrowError(/循环引用/)
  })

  it('日期按 ISO 字符串参与摘要', () => {
    expect(canonicalJson({ at: new Date('2025-09-01T00:00:00.000Z') })).toBe(
      canonicalJson({ at: '2025-09-01T00:00:00.000Z' }),
    )
  })
})
