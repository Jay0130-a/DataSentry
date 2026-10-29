import { describe, expect, it } from 'vitest'
import { renderToolResult } from '@datasentry/backend/agent/prompt.ts'
import type { AgentStepRecord } from '@datasentry/backend/agent/backend.ts'

function step(overrides: Partial<AgentStepRecord>): AgentStepRecord {
  return {
    step: 0,
    toolName: 'datasentry__read_source_guide',
    args: { sourceSlug: 'erp' },
    status: 'succeeded',
    ...overrides,
  }
}

describe('工具结果渲染给模型', () => {
  it('有取数结果时回数据与完整性', () => {
    const text = renderToolResult(
      step({
        toolName: 'mcp__erp__fetch_revenue',
        result: {
          resultId: 'res_1',
          toolName: 'mcp__erp__fetch_revenue',
          sourceRef: { slug: 'erp', tool: 'fetch_revenue', dataVersion: 'erp:2025-09:v1' },
          completeness: 'full',
          data: { totalRevenue: 100 },
          meta: { dataVersion: 'erp:2025-09:v1', completeness: 'full', rowCount: 3 },
        },
      }),
    )

    expect(text).toContain('totalRevenue')
    expect(text).toContain('full')
  })

  it('内置工具成功但没取数结果时，回的是 note 而不是「失败」', () => {
    // 这条是回归：早先的实现只在 `succeeded && result` 时回成功，
    // 而读 guide 这类内置工具没有 result，于是成功的调用被渲染成
    // 「调用未成功：UNKNOWN」——模型据此判定全线失败并放弃任务。
    const text = renderToolResult(step({ note: '已读取 erp 的 guide（1200 字节）…' }))

    expect(text).toContain('已读取 erp 的 guide')
    expect(text).not.toContain('调用未成功')
    expect(text).not.toContain('UNKNOWN')
  })

  it('成功但既无结果也无 note 时，明确说成功而不是失败', () => {
    const text = renderToolResult(step({}))
    expect(text).toContain('成功')
    expect(text).not.toContain('调用未成功')
  })

  it('被拒绝/失败时带错误码与原因', () => {
    const text = renderToolResult(
      step({ status: 'denied', errorCode: 'GUIDE_NOT_READ', errorMessage: '先读 guide' }),
    )
    expect(text).toContain('调用未成功')
    expect(text).toContain('GUIDE_NOT_READ')
    expect(text).toContain('先读 guide')
  })
})
