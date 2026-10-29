import { ErrorCode, fail } from '@datasentry/core'

/**
 * 从一句自然语言需求里识别会计期间。
 *
 * 这一层存在的意义：`request` 不能只是「被记录」，它必须能驱动执行。
 * 否则「出 2025 年 8 月的月报」配上一个 `period: 2025-06`，系统会安静地
 * 按 6 月跑完并出一份看起来正常的报表——和审批漂移是同一类问题：
 * **说的是 A，做的是 B，而且不报错。**
 *
 * 所以这里的策略是**宁可不猜**：识别不到就报错让调用方说清楚；
 * 识别到多个互相矛盾的就报歧义；和显式输入冲突就报冲突。
 */

/** 会计期间的标准形态。 */
const CANONICAL_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/

export interface ParsedPeriod {
  /** 规范化后的 `YYYY-MM`；识别不到时为 null。 */
  period: string | null
  /** 命中的原始片段，用于错误信息与排查。 */
  matches: string[]
  /** 命中了多个互相矛盾的期间。 */
  ambiguous: boolean
}

/**
 * 把一个「像期间」的字符串规范化成 `YYYY-MM`。
 *
 * 支持 `2025-09`、`2025/9`、`2025.09`、`2025年9月`。
 * 认不出来返回 null——**不抛错**：显式输入是否合法由工具的参数 Schema 判断，
 * 这里只负责「能不能对得上」。
 */
export function normalizePeriod(value: string): string | null {
  const text = value.trim()

  // 规范形态也要过一遍范围校验：`1999-01` 形式上合法，但不是这个系统认的期间。
  const canonical = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(text)
  if (canonical) return buildPeriod(Number(canonical[1]), Number(canonical[2]))

  const loose = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?$/.exec(text)
  if (!loose) return null
  return buildPeriod(Number(loose[1]), Number(loose[2]))
}

function buildPeriod(year: number, month: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null
  if (year < 2000 || year > 2100) return null
  if (month < 1 || month > 12) return null
  return `${year}-${String(month).padStart(2, '0')}`
}

function shiftMonth(year: number, month: number, delta: number): string {
  const total = year * 12 + (month - 1) + delta
  return buildPeriod(Math.floor(total / 12), (total % 12) + 1) ?? ''
}

/**
 * 从需求文本里抽期间。
 *
 * 相对表达（本月/上月/下月）依赖服务端时钟——这是它的语义决定的，
 * 报表系统里「出上个月的月报」本来就是个常用说法。为了让测试可控，
 * `now` 可以注入。
 */
export function parsePeriodFromRequest(text: string, now: Date = new Date()): ParsedPeriod {
  const matches: string[] = []
  const periods = new Set<string>()

  const add = (raw: string, period: string | null): void => {
    if (!period) return
    matches.push(raw.trim())
    periods.add(period)
  }

  // 1. 绝对写法：2025-09 / 2025/9 / 2025.09 / 2025 年 9 月
  for (const match of text.matchAll(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?/g)) {
    add(match[0], buildPeriod(Number(match[1]), Number(match[2])))
  }

  // 2. 相对写法。
  //
  // 用**一个**交替正则而不是逐个 pattern 跑：`上上个月` 里包含 `上个月`，
  // 分开匹配会同时命中两种表达、算出两个不同的期间，把一个本来明确的句子
  // 判成「歧义」。交替正则按从左到右的顺序尝试，长的写法在前，命中后整体跳过。
  const relativeYear = now.getUTCFullYear()
  const relativeMonth = now.getUTCMonth() + 1
  const deltaByExpression: Record<string, number> = {
    上上个月: -2,
    上上月: -2,
    上个月: -1,
    上月: -1,
    本月: 0,
    这个月: 0,
    当月: 0,
    下个月: 1,
    下月: 1,
  }
  for (const match of text.matchAll(/上上个月|上上月|上个月|上月|本月|这个月|当月|下个月|下月/g)) {
    const delta = deltaByExpression[match[0]]
    if (delta === undefined) continue
    add(match[0], shiftMonth(relativeYear, relativeMonth, delta) || null)
  }

  return {
    period: periods.size === 1 ? [...periods][0]! : null,
    matches,
    ambiguous: periods.size > 1,
  }
}

export interface ResolvedPeriod {
  period: string
  /** `explicit` 表示调用方给了结构化输入，`parsed` 表示从需求文本里解析得到。 */
  source: 'explicit' | 'parsed'
}

/**
 * 决定这次任务到底跑哪个期间。
 *
 * 三条规则，按顺序：
 * 1. 显式输入优先——但若需求文本里写的是另一个期间，**冲突报错**，不静默采信任何一方。
 * 2. 没有显式输入就从需求文本里取。
 * 3. 两者都没有就报错，要求调用方说清楚。
 */
export function resolvePeriod(input: {
  request: string
  explicitPeriod?: unknown
  now?: Date
}): ResolvedPeriod {
  const explicit =
    typeof input.explicitPeriod === 'string' && input.explicitPeriod.trim().length > 0
      ? input.explicitPeriod
      : undefined

  const parsed = parsePeriodFromRequest(input.request, input.now)

  if (parsed.ambiguous) {
    fail(
      ErrorCode.REQUEST_PERIOD_AMBIGUOUS,
      `需求里出现了多个互相矛盾的会计期间：${parsed.matches.join('、')}。请只保留一个，或用结构化输入明确指定`,
      { request: input.request, matches: parsed.matches },
    )
  }

  const explicitNormalized = explicit ? normalizePeriod(explicit) : null

  if (explicit && parsed.period && explicitNormalized && explicitNormalized !== parsed.period) {
    fail(
      ErrorCode.REQUEST_PERIOD_CONFLICT,
      `需求里写的是 ${parsed.period}，但结构化输入是 ${explicit}。两者不一致时不会替你选一个——请改成一致`,
      { request: input.request, requestPeriod: parsed.period, explicitPeriod: explicit },
    )
  }

  if (explicit) {
    // 显式值原样使用：它合不合法由工具的参数 Schema 判断，
    // 这一层不替它做格式规整（否则「非法参数被拒」的路径就被悄悄改宽了）。
    return { period: explicit, source: 'explicit' }
  }

  if (parsed.period) return { period: parsed.period, source: 'parsed' }

  fail(
    ErrorCode.REQUEST_PERIOD_MISSING,
    `没能从需求「${input.request}」里识别出会计期间。请写成「出 2025 年 9 月的经营月报」这样，或显式指定 period`,
    { request: input.request },
  )
}

/** 需求文本是否已经包含了能驱动执行的期间。UI 用它给即时提示。 */
export function describePeriodRequirement(text: string, now: Date = new Date()): string | null {
  const parsed = parsePeriodFromRequest(text, now)
  if (parsed.ambiguous) return `识别到多个期间，请只保留一个：${parsed.matches.join('、')}`
  if (!parsed.period) return '还没有识别出会计期间，例如写「2025 年 9 月」'
  return null
}

export { CANONICAL_PERIOD }
