import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCode, isDataSentryError } from '@datasentry/core'
import { AuthService, type AuthServiceOptions } from '@datasentry/backend/auth/service.ts'
import { hashPassword, verifyPassword } from '@datasentry/backend/auth/password.ts'
import { openDatabase, type DatabaseHandle } from '@datasentry/backend/db/index.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths | null = null
let handle: DatabaseHandle | null = null

function setup(options: AuthServiceOptions = {}, env: NodeJS.ProcessEnv = {}): AuthService {
  temp = tempPaths('datasentry-auth-')
  handle = openDatabase(temp.paths)
  const service = new AuthService(handle, options)
  service.ensureSeeded(env)
  return service
}

afterEach(() => {
  handle?.close()
  temp?.cleanup()
  handle = null
  temp = null
})

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (isDataSentryError(err)) return err.code
    throw err
  }
  throw new Error('期望抛错，但没有抛')
}

describe('口令摘要', () => {
  it('同一口令两次摘要不同（盐不同），但都能校验通过', () => {
    const a = hashPassword('correct horse battery staple')
    const b = hashPassword('correct horse battery staple')

    expect(a).not.toBe(b)
    expect(verifyPassword('correct horse battery staple', a)).toBe(true)
    expect(verifyPassword('correct horse battery staple', b)).toBe(true)
    expect(verifyPassword('wrong', a)).toBe(false)
  })

  it('格式不对的摘要直接判失败，不抛异常', () => {
    expect(verifyPassword('x', 'plain-text')).toBe(false)
    expect(verifyPassword('x', 'scrypt$1$2$3$zz$zz')).toBe(false)
  })
})

describe('初始账号', () => {
  it('空库时建两个账号，重复调用不再建', () => {
    temp = tempPaths('datasentry-auth-')
    handle = openDatabase(temp.paths)
    const service = new AuthService(handle)

    const first = service.ensureSeeded({})
    expect(first.created).toEqual(['admin', 'analyst'])
    expect(first.defaultPasswords).toBe(true)
    expect(service.countUsers()).toBe(2)

    const second = service.ensureSeeded({})
    expect(second.created).toEqual([])
  })

  it('生产环境缺少初始口令时启动失败，而不是悄悄用默认口令', () => {
    temp = tempPaths('datasentry-auth-')
    handle = openDatabase(temp.paths)
    const service = new AuthService(handle)

    expect(codeOf(() => service.ensureSeeded({ NODE_ENV: 'production' }))).toBe(
      ErrorCode.AUTH_CONFIG_INVALID,
    )
    expect(service.countUsers()).toBe(0)
  })

  it('生产环境给了口令就正常建号，且不标记为默认口令', () => {
    temp = tempPaths('datasentry-auth-')
    handle = openDatabase(temp.paths)
    const service = new AuthService(handle)

    const result = service.ensureSeeded({
      NODE_ENV: 'production',
      DATASENTRY_ADMIN_PASSWORD: 'admin-from-env',
      DATASENTRY_ANALYST_PASSWORD: 'analyst-from-env',
    })
    expect(result.created).toEqual(['admin', 'analyst'])
    expect(result.defaultPasswords).toBe(false)
  })
})

describe('登录与令牌', () => {
  it('登录成功返回令牌，库里只存令牌摘要', () => {
    const service = setup()
    const result = service.login({ username: 'admin', password: 'datasentry-admin' })

    expect(result.user.username).toBe('admin')
    expect(result.user.role).toBe('admin')
    expect(result.token.length).toBeGreaterThan(20)

    const rows = handle!.sqlite.prepare('SELECT token_hash FROM auth_session').all() as {
      token_hash: string
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.token_hash).not.toBe(result.token)
    expect(rows[0]!.token_hash).toBe(createHash('sha256').update(result.token).digest('hex'))
  })

  it('有效令牌能换回身份，乱写的令牌不能', () => {
    const service = setup()
    const { token } = service.login({ username: 'analyst', password: 'datasentry-analyst' })

    expect(service.authenticate(token)?.username).toBe('analyst')
    expect(service.authenticate('not-a-token')).toBeNull()
    expect(service.authenticate('')).toBeNull()
  })

  it('口令错误与账号不存在返回同一个错误码', () => {
    const service = setup()

    expect(
      codeOf(() => service.login({ username: 'admin', password: 'nope' })),
    ).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS)
    expect(
      codeOf(() => service.login({ username: 'ghost', password: 'nope' })),
    ).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS)
  })

  it('停用的账号不能登录', () => {
    const service = setup()
    handle!.sqlite.prepare("UPDATE user SET disabled = 1 WHERE username = 'analyst'").run()

    expect(
      codeOf(() => service.login({ username: 'analyst', password: 'datasentry-analyst' })),
    ).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS)
  })

  it('登出即吊销，旧令牌立刻失效', () => {
    const service = setup()
    const { token } = service.login({ username: 'admin', password: 'datasentry-admin' })
    expect(service.authenticate(token)).not.toBeNull()

    service.logout(token)
    expect(service.authenticate(token)).toBeNull()
  })

  it('过期令牌视为不存在，并顺手吊销', () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const service = setup({ ttlMs: 60_000, now: () => new Date(nowMs) })

    const { token } = service.login({ username: 'admin', password: 'datasentry-admin' })
    expect(service.authenticate(token)).not.toBeNull()

    nowMs += 61_000
    expect(service.authenticate(token)).toBeNull()

    const row = handle!.sqlite.prepare('SELECT revoked_at FROM auth_session').get() as {
      revoked_at: string | null
    }
    expect(row.revoked_at).not.toBeNull()
  })

  it('连续失败达到阈值后进入节流，窗口过后恢复', () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const service = setup({ maxFailures: 3, windowMs: 60_000, now: () => new Date(nowMs) })

    for (let i = 0; i < 3; i += 1) {
      expect(
        codeOf(() => service.login({ username: 'admin', password: 'wrong' })),
      ).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS)
    }

    expect(
      codeOf(() => service.login({ username: 'admin', password: 'datasentry-admin' })),
    ).toBe(ErrorCode.AUTH_RATE_LIMITED)

    nowMs += 61_000
    const result = service.login({ username: 'admin', password: 'datasentry-admin' })
    expect(result.user.username).toBe('admin')
  })
})

describe('登录审计', () => {
  /** 时间递增，保证审计的顺序断言不受毫秒内并发影响。 */
  function ticking(): () => Date {
    let ms = Date.parse('2026-02-01T00:00:00.000Z')
    return () => new Date((ms += 1000))
  }

  it('成功、失败、登出都留痕，且带来源地址', () => {
    const service = setup({ now: ticking() })
    const { token } = service.login({
      username: 'admin',
      password: 'datasentry-admin',
      ip: '10.0.0.1',
      userAgent: 'unit-test',
    })
    expect(() =>
      service.login({ username: 'admin', password: 'bad', ip: '10.0.0.2' }),
    ).toThrow()
    service.logout(token, { ip: '10.0.0.3' })

    const entries = service.recentAudit()
    expect(entries.map((entry) => entry.event)).toEqual([
      'logout',
      'login.failed',
      'login.success',
    ])
    expect(entries[1]!.reason).toBe('bad-password')
    expect(entries[2]!.ip).toBe('10.0.0.1')
    expect(entries[2]!.userAgent).toBe('unit-test')
    expect(entries[2]!.userId).not.toBeNull()
  })

  it('账号不存在与口令错误在审计里分得开', () => {
    const service = setup({ now: ticking() })
    expect(() => service.login({ username: 'ghost', password: 'x' })).toThrow()

    const entry = service.recentAudit()[0]!
    expect(entry.event).toBe('login.failed')
    expect(entry.reason).toBe('unknown-user')
    expect(entry.userId).toBeNull()
  })

  it('节流也会留痕', () => {
    const service = setup({ maxFailures: 1, windowMs: 60_000, now: ticking() })

    expect(() => service.login({ username: 'admin', password: 'bad' })).toThrow()
    expect(() => service.login({ username: 'admin', password: 'bad' })).toThrow()

    expect(service.recentAudit().some((entry) => entry.reason === 'rate-limited')).toBe(true)
  })

  it('显示名可以批量回填，用于任务上的「发起人」', () => {
    const service = setup()
    const admin = service.login({ username: 'admin', password: 'datasentry-admin' })

    const names = service.displayNamesFor([admin.user.id, null, 'usr_not_exist'])
    expect(names.get(admin.user.id)).toBe('系统管理员')
    expect(names.size).toBe(1)
    expect(service.displayNameOf(null)).toBeNull()
  })
})
