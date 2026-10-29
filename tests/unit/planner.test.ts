import { describe, expect, it } from 'vitest'
import { buildScope, evaluateTemplate, renderArgs, type TemplateScope } from '@datasentry/backend/agent/planner.ts'

const scope: TemplateScope = {
  input: { period: '2025-09', buCodes: ['BU-EAST'] },
  session: { id: 'sess_1' },
  steps: {
    businessUnits: {
      data: {
        businessUnits: [
          { code: 'BU-EAST', name: '华东制造事业部' },
          { code: 'BU-SOUTH', name: '华南零售事业部' },
        ],
      },
      meta: { rowCount: 2 },
    },
  },
}

describe('计划模板求值', () => {
  it('取输入字段', () => {
    expect(evaluateTemplate('input.period', scope)).toBe('2025-09')
  })

  it('取前序步骤结果，并用 pluck 抽字段数组', () => {
    expect(evaluateTemplate('steps.businessUnits.data.businessUnits | pluck:code', scope)).toEqual([
      'BU-EAST',
      'BU-SOUTH',
    ])
  })

  it('取前序步骤的 meta', () => {
    expect(evaluateTemplate('steps.businessUnits.meta.rowCount', scope)).toBe(2)
  })

  it('整串是单个模板时保留原始类型', () => {
    const rendered = renderArgs(
      { buCodes: '{{ steps.businessUnits.data.businessUnits | pluck:code }}' },
      scope,
    )
    expect(Array.isArray(rendered['buCodes'])).toBe(true)
    expect(rendered['buCodes']).toEqual(['BU-EAST', 'BU-SOUTH'])
  })

  it('混在文本里时做字符串插值', () => {
    const rendered = renderArgs({ note: '期间 {{ input.period }}（共 2 个事业部）' }, scope)
    expect(rendered['note']).toBe('期间 2025-09（共 2 个事业部）')
  })

  it('嵌套对象与数组里的模板都会被渲染', () => {
    const rendered = renderArgs(
      { filter: { period: '{{ input.period }}', codes: ['{{ input.buCodes | json }}'] } },
      scope,
    )
    expect(rendered).toEqual({
      filter: { period: '2025-09', codes: ['["BU-EAST"]'] },
    })
  })

  it('引用未执行的步骤时报错，而不是静默变成 undefined', () => {
    expect(() => evaluateTemplate('steps.notYet.data.x', scope)).toThrowError(/尚未执行/)
  })

  it('引用不合法的根时报错', () => {
    expect(() => evaluateTemplate('env.SECRET', scope)).toThrowError(/根必须是/)
  })

  it('引用不存在的过滤器时报错', () => {
    expect(() => evaluateTemplate('input.period | shell', scope)).toThrowError(/未知的模板过滤器/)
  })

  it('buildScope 只暴露已完成的步骤', () => {
    const built = buildScope(
      { period: '2025-09' },
      { id: 'sess_1' },
      {
        done: {
          resultId: 'res_1',
          toolName: 't',
          sourceRef: { slug: 's', tool: 't', dataVersion: 'v1' },
          completeness: 'full',
          data: { a: 1 },
          meta: { dataVersion: 'v1', completeness: 'full', rowCount: 1 },
        },
        pending: undefined,
      },
    )
    expect(Object.keys(built.steps)).toEqual(['done'])
  })
})
