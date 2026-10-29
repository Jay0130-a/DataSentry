import type { ToolResult } from '@datasentry/core'
import type { PlanStep } from '../harness/skill-loader.ts'

/**
 * 计划模板求值。
 *
 * 计划里的参数可以引用输入和前面步骤的输出：
 *
 * ```yaml
 * args:
 *   period: "{{ input.period }}"
 *   buCodes: "{{ steps.businessUnits.data.businessUnits | pluck:code }}"
 * ```
 *
 * 规则：整个字符串就是一个 `{{ }}` 时返回**原始类型**（数组还是数组）；
 * 混在文本里则做字符串插值。
 *
 * 这层存在的意义是让计划真的依赖前面的取数结果，而不是背一串写死的常量——
 * 否则「Agent 规划」就退化成照本宣科，也测不出步骤间依赖。
 */
export interface TemplateScope {
  input: Record<string, unknown>
  session: Record<string, unknown>
  steps: Record<string, { data: unknown; meta: Record<string, unknown> }>
}

const SOLE_TEMPLATE = /^\s*\{\{([^}]+)\}\}\s*$/
const INLINE_TEMPLATE = /\{\{([^}]+)\}\}/g

function resolvePath(root: unknown, path: string[]): unknown {
  let current = root
  for (const key of path) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(key)
      if (!Number.isInteger(index)) return undefined
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function applyFilter(value: unknown, filter: string): unknown {
  const [name, arg] = filter.split(':')
  if (name === 'pluck') {
    if (!Array.isArray(value) || arg === undefined) return value
    return value.map((item) =>
      item !== null && typeof item === 'object'
        ? (item as Record<string, unknown>)[arg]
        : undefined,
    )
  }
  if (name === 'join') {
    return Array.isArray(value) ? value.join(arg ?? ',') : String(value)
  }
  if (name === 'json') {
    return JSON.stringify(value)
  }
  throw new Error(`未知的模板过滤器 "${name}"（可用：pluck / join / json）`)
}

export function evaluateTemplate(expression: string, scope: TemplateScope): unknown {
  const parts = expression.split('|').map((p) => p.trim())
  const pathExpr = parts[0]
  if (!pathExpr) throw new Error(`模板表达式为空：{{${expression}}}`)

  const segments = pathExpr.split('.').map((s) => s.trim())
  const [root, ...rest] = segments
  let value: unknown

  switch (root) {
    case 'input':
      value = resolvePath(scope.input, rest)
      break
    case 'session':
      value = resolvePath(scope.session, rest)
      break
    case 'steps': {
      const [stepId, kind, ...tail] = rest
      if (!stepId || (kind !== 'data' && kind !== 'meta')) {
        throw new Error(`模板引用必须是 steps.<id>.data.* 或 steps.<id>.meta.*：{{${expression}}}`)
      }
      const step = scope.steps[stepId]
      if (!step) throw new Error(`模板引用了尚未执行的步骤 "${stepId}"：{{${expression}}}`)
      value = resolvePath(kind === 'data' ? step.data : step.meta, tail)
      break
    }
    default:
      throw new Error(`模板引用的根必须是 input / session / steps 之一：{{${expression}}}`)
  }

  for (const filter of parts.slice(1)) {
    value = applyFilter(value, filter)
  }
  return value
}

/** 字符串值：整体为单个模板时保留原始类型，否则插值。 */
function renderString(value: string, scope: TemplateScope): unknown {
  const sole = SOLE_TEMPLATE.exec(value)
  if (sole?.[1] !== undefined) return evaluateTemplate(sole[1], scope)

  return value.replaceAll(INLINE_TEMPLATE, (_match, expr: string) => {
    const resolved = evaluateTemplate(expr, scope)
    return resolved === undefined || resolved === null ? '' : String(resolved)
  })
}

export function renderArgs(
  args: Record<string, unknown>,
  scope: TemplateScope,
): Record<string, unknown> {
  const render = (value: unknown): unknown => {
    if (typeof value === 'string') return renderString(value, scope)
    if (Array.isArray(value)) return value.map(render)
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = render(v)
      }
      return out
    }
    return value
  }

  return render(args) as Record<string, unknown>
}

/** 把步骤 id 映射到它的执行结果，供模板引用。 */
export function buildScope(
  input: Record<string, unknown>,
  session: Record<string, unknown>,
  results: Record<string, ToolResult | undefined>,
): TemplateScope {
  const steps: TemplateScope['steps'] = {}
  for (const [id, result] of Object.entries(results)) {
    if (result) steps[id] = { data: result.data, meta: result.meta }
  }
  return { input, session, steps }
}

export type { PlanStep }
