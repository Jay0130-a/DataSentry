import { describe, expect, it } from 'vitest'
import { ErrorCode, isDataSentryError } from '@datasentry/core'
import {
  normalizePeriod,
  parsePeriodFromRequest,
  resolvePeriod,
} from '@datasentry/backend/reports/request-parser.ts'

const NOW = new Date('2026-05-15T00:00:00.000Z')

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (isDataSentryError(err)) return err.code
    return `UNEXPECTED: ${err instanceof Error ? err.message : String(err)}`
  }
  return 'NO_ERROR'
}

describe('期间规范化', () => {
  it.each([
    ['2025-09', '2025-09'],
    ['2025/9', '2025-09'],
    ['2025.09', '2025-09'],
    ['2025年9月', '2025-09'],
    ['2025 年 09 月', '2025-09'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePeriod(input)).toBe(expected)
  })

  it.each(['', '2025-13', '2025-00', 'abc', '1999-01', '2025'])('认不出来返回 null：%s', (input) => {
    expect(normalizePeriod(input)).toBeNull()
  })
})

describe('从需求文本识别期间', () => {
  it.each([
    ['出 2025 年 9 月的经营月报', '2025-09'],
    ['生成 2025-08 经营月报', '2025-08'],
    ['帮我出2025/07的月报', '2025-07'],
    ['2025.06 经营月报，重点看华东', '2025-06'],
  ])('%s → %s', (text, expected) => {
    expect(parsePeriodFromRequest(text, NOW).period).toBe(expected)
  })

  it('相对表达按注入的时钟计算', () => {
    expect(parsePeriodFromRequest('出上个月的月报', NOW).period).toBe('2026-04')
    expect(parsePeriodFromRequest('出上上个月的月报', NOW).period).toBe('2026-03')
    expect(parsePeriodFromRequest('出本月的月报', NOW).period).toBe('2026-05')
    expect(parsePeriodFromRequest('出下个月的月报', NOW).period).toBe('2026-06')
  })

  it('跨年时相对表达正确回绕', () => {
    const january = new Date('2026-01-10T00:00:00.000Z')
    expect(parsePeriodFromRequest('出上个月的月报', january).period).toBe('2025-12')
  })

  it('相对表达按 Workspace 时区计算，而不是 UTC', () => {
    // UTC 还是 10 月 31 日，上海已经是 11 月 1 日凌晨。
    const now = new Date('2025-11-01T01:00:00+08:00')
    expect(parsePeriodFromRequest('出本月的月报', now).period).toBe('2025-10')
    expect(parsePeriodFromRequest('出本月的月报', now, 'Asia/Shanghai').period).toBe('2025-11')
    expect(parsePeriodFromRequest('出上个月的月报', now, 'Asia/Shanghai').period).toBe('2025-10')
    expect(
      resolvePeriod({ request: '出上个月的月报', now, timeZone: 'Asia/Shanghai' }).period,
    ).toBe('2025-10')
  })

  it('「上上个月」不会被「上个月」同时命中而误判歧义', () => {
    // 「上上个月」里包含「上个月」这三个字，分开匹配会算出两个期间。
    // 用交替正则可以保证只命中更长的那一个。
    const parsed = parsePeriodFromRequest('出上上个月的月报', NOW)
    expect(parsed.ambiguous).toBe(false)
    expect(parsed.period).toBe('2026-03')
  })

  it('没有任何期间时返回 null', () => {
    expect(parsePeriodFromRequest('出个经营月报', NOW).period).toBeNull()
  })

  it('出现两个不同期间时判为歧义', () => {
    const parsed = parsePeriodFromRequest('对比 2025 年 8 月和 2025 年 9 月的月报', NOW)
    expect(parsed.ambiguous).toBe(true)
    expect(parsed.period).toBeNull()
  })

  it('同一期间的不同写法不算歧义', () => {
    const parsed = parsePeriodFromRequest('2025 年 9 月（2025-09）的经营月报', NOW)
    expect(parsed.ambiguous).toBe(false)
    expect(parsed.period).toBe('2025-09')
  })
})

describe('决定本次到底跑哪个期间', () => {
  it('只给需求：从文本里解析', () => {
    expect(
      resolvePeriod({ request: '出 2025 年 9 月的经营月报', now: NOW }),
    ).toEqual({ period: '2025-09', source: 'parsed' })
  })

  it('只给显式输入：直接用', () => {
    expect(
      resolvePeriod({ request: '出个月报', explicitPeriod: '2025-09', now: NOW }),
    ).toEqual({ period: '2025-09', source: 'explicit' })
  })

  it('两者一致（不同写法）：不报错', () => {
    expect(
      resolvePeriod({ request: '出 2025 年 9 月的经营月报', explicitPeriod: '2025/09', now: NOW }),
    ).toEqual({ period: '2025/09', source: 'explicit' })
  })

  it('两者矛盾：报冲突，不替调用方选一个', () => {
    // 这正是要防的那件事：「说的是 8 月、跑的是 6 月、而且看起来一切正常」
    expect(
      codeOf(() =>
        resolvePeriod({
          request: '出 2025 年 8 月的经营月报',
          explicitPeriod: '2025-06',
          now: NOW,
        }),
      ),
    ).toBe(ErrorCode.REQUEST_PERIOD_CONFLICT)
  })

  it('显式输入格式非法时不在这里纠正——留给参数 Schema 拒', () => {
    // 「2025/13」认不出是哪个期间，所以不参与冲突比较，原样传给下游
    expect(
      resolvePeriod({ request: '出 2025 年 9 月的经营月报', explicitPeriod: '2025/13', now: NOW }),
    ).toEqual({ period: '2025/13', source: 'explicit' })
  })

  it('都识别不到：报缺失，而不是默认一个期间', () => {
    expect(codeOf(() => resolvePeriod({ request: '出个报表', now: NOW }))).toBe(
      ErrorCode.REQUEST_PERIOD_MISSING,
    )
  })

  it('多个矛盾期间：报歧义', () => {
    expect(
      codeOf(() =>
        resolvePeriod({ request: '对比 2025 年 8 月和 2025 年 9 月', now: NOW }),
      ),
    ).toBe(ErrorCode.REQUEST_PERIOD_AMBIGUOUS)
  })
})
