import { describe, expect, it } from 'vitest'
import { dataPaths, validateWithJsonSchema } from '@datasentry/core'
import { loadSource } from '@datasentry/backend/sources/loader.ts'

describe('reporting-db 工具契约', () => {
  const source = loadSource('reporting-db', dataPaths())
  const tool = source.config.tools.find((item) => item.name === 'revenue_by_bu')

  it('期间只接受合法的 01-12 月份', () => {
    expect(tool).toBeDefined()
    const ok = validateWithJsonSchema(tool!.paramsSchema, {
      period: '2025-12',
      buCodes: ['BU-A'],
    })
    expect(ok.ok).toBe(true)

    for (const period of ['2025-13', '2025-00']) {
      const bad = validateWithJsonSchema(tool!.paramsSchema, {
        period,
        buCodes: ['BU-A'],
      })
      expect(bad.ok, `${period} 不应通过`).toBe(false)
    }
  })
})
