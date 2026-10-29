import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import { ErrorCode, fail } from '@datasentry/core'
import type { DatabaseHandle } from '../db/index.ts'
import { schema } from '../db/index.ts'
import type { UserRole } from '../db/schema.ts'
import { hashPassword, verifyPassword } from './password.ts'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  /** 审批角色。Workspace 的 approvalPolicy 按这些名字判定资格。 */
  approverRoles: string[]
}

export interface LoginResult {
  token: string
  expiresAt: string
  user: AuthUser
}

/** 登录审计条目。 */
export interface AuthAuditEntry {
  id: string
  event: string
  userId: string | null
  username: string
  at: string
  ip: string | null
  userAgent: string | null
  reason: string | null
}

export interface SeedResult {
  created: string[]
  /** 是否用了内置默认口令——调用方应当把这件事大声说出来。 */
  defaultPasswords: boolean
  /** 业务用户被授予的 Workspace。 */
  grantedWorkspaces: string[]
}

export interface AuthServiceOptions {
  /** 登录会话有效期。 */
  ttlMs?: number
  /** 同一账号在窗口期内允许多少次失败。 */
  maxFailures?: number
  windowMs?: number
  now?: () => Date
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
const DEFAULT_MAX_FAILURES = 5
const DEFAULT_WINDOW_MS = 5 * 60 * 1000

const SEED_ACCOUNTS = [
  {
    username: 'admin',
    displayName: '系统管理员',
    role: 'admin' as const,
    envKey: 'DATASENTRY_ADMIN_PASSWORD',
    fallback: 'datasentry-admin',
    rolesEnvKey: 'DATASENTRY_ADMIN_APPROVER_ROLES',
    defaultRoles: ['cfo', 'finance-approver', 'team-lead'],
  },
  {
    username: 'analyst',
    displayName: '业务用户',
    role: 'analyst' as const,
    envKey: 'DATASENTRY_ANALYST_PASSWORD',
    fallback: 'datasentry-analyst',
    rolesEnvKey: 'DATASENTRY_ANALYST_APPROVER_ROLES',
    defaultRoles: ['finance-approver', 'team-lead'],
  },
] as const

function tokenHashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 账号不存在时也走一次同等代价的校验，避免用响应时间探出哪些用户名存在。 */
let dummyHash: string | null = null
function dummyHashOf(): string {
  dummyHash ??= hashPassword('datasentry-not-a-real-password')
  return dummyHash
}

function toUser(row: typeof schema.users.$inferSelect): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    approverRoles: row.approverRoles ?? [],
  }
}

function rolesFor(
  account: (typeof SEED_ACCOUNTS)[number],
  env: NodeJS.ProcessEnv,
): string[] {
  const configured = env[account.rolesEnvKey]
  if (configured !== undefined && configured.trim() !== '') {
    return configured
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return [...account.defaultRoles]
}

/**
 * 身份：账号、登录会话、失败节流。
 *
 * 三条刻意的选择：
 * - **令牌只存摘要**（和 Source 凭据同一条规矩）：库被读走也拿不到能用的令牌。
 * - **口令错误一律同一句话**：不区分「没这个用户」和「口令不对」，
 *   否则登录接口就成了账号枚举器。
 * - **失败次数按账号计数**：这是最便宜的一道暴力破解闸门；分布式部署时
 *   应换成共享存储，但单实例下它确实有效。
 */
export class AuthService {
  private readonly failures = new Map<string, { count: number; resetAt: number }>()
  private readonly ttlMs: number
  private readonly maxFailures: number
  private readonly windowMs: number
  private readonly now: () => Date

  constructor(
    private readonly database: DatabaseHandle,
    options: AuthServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.now = options.now ?? (() => new Date())
  }

  countUsers(): number {
    return this.database.db.select({ id: schema.users.id }).from(schema.users).all().length
  }

  /**
   * 首次启动时建两个账号，并给业务用户授权 Workspace。
   *
   * 生产环境缺少初始口令就直接失败：悄悄用 `datasentry-admin` 起服务，
   * 比启动失败危险得多。
   */
  ensureSeeded(
    env: NodeJS.ProcessEnv = process.env,
    workspaceIds: readonly string[] = [],
  ): SeedResult {
    const created = this.countUsers() === 0 ? this.createSeedUsers(env) : null
    const grantedWorkspaces = this.ensureMemberships(env, workspaceIds)
    this.ensureApproverRoles(env)

    return {
      created: created?.usernames ?? [],
      defaultPasswords: created?.usedDefaultPasswords ?? false,
      grantedWorkspaces,
    }
  }

  private createSeedUsers(env: NodeJS.ProcessEnv): {
    usernames: string[]
    usedDefaultPasswords: boolean
  } {
    const production = env['NODE_ENV'] === 'production'
    const resolved = SEED_ACCOUNTS.map((account) => {
      const configured = env[account.envKey]?.trim() ?? ''
      if (!configured && production) {
        fail(
          ErrorCode.AUTH_CONFIG_INVALID,
          `生产环境必须通过 ${account.envKey} 指定初始口令，不能使用内置默认口令`,
          { username: account.username },
        )
      }
      return { account, password: configured || account.fallback }
    })

    const createdAt = this.now().toISOString()
    for (const { account, password } of resolved) {
      this.database.db
        .insert(schema.users)
        .values({
          id: `usr_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          username: account.username,
          displayName: account.displayName,
          role: account.role,
          passwordHash: hashPassword(password),
          approverRoles: rolesFor(account, env),
          disabled: 0,
          createdAt,
        })
        .run()
    }

    return {
      usernames: resolved.map(({ account }) => account.username),
      usedDefaultPasswords: resolved.some(
        ({ account, password }) => password === account.fallback,
      ),
    }
  }

  /**
   * 给业务用户授 Workspace。
   *
   * 只在**整张授权表为空**时执行：既覆盖首次建号，也覆盖「账号已经有了、
   * 但授权表是这次升级才建的」的老库。一旦有任何一条授权，就不再自动补，
   * 免得把管理员手工收回的权限又发回去。
   */
  private ensureMemberships(
    env: NodeJS.ProcessEnv,
    workspaceIds: readonly string[],
  ): string[] {
    const existing = this.database.db
      .select({ userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .limit(1)
      .all()
    if (existing.length > 0) return []

    const analyst = this.database.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.username, 'analyst'))
      .get()
    if (!analyst) return []

    /*
     * 业务用户默认只拿到**第一个** Workspace，不是全部。
     *
     * 「新账号默认什么都能看」是最容易埋下去的越权：它不会报错，
     * 只会让每个登录用户看到本不该看的数据。要开更多，显式列出来。
     */
    const configured = (env['DATASENTRY_ANALYST_WORKSPACES'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const granted = configured.length > 0 ? configured : workspaceIds.slice(0, 1)

    const createdAt = this.now().toISOString()
    for (const workspaceId of granted) {
      this.database.db
        .insert(schema.workspaceMembers)
        .values({ userId: analyst.id, workspaceId, createdAt })
        .run()
    }

    return granted
  }

  /**
   * 补齐审批角色。
   *
   * 只在**全员角色都为空**时执行：既覆盖首次建号，也覆盖「账号已经有了、
   * 但角色列是这次升级才加的」老库。一旦有人带了角色，就不再自动补，
   * 免得把管理员手工收回的审批资格又发回去。
   */
  private ensureApproverRoles(env: NodeJS.ProcessEnv): void {
    const rows = this.database.db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        approverRoles: schema.users.approverRoles,
      })
      .from(schema.users)
      .all()
    if (rows.some((row) => (row.approverRoles ?? []).length > 0)) return

    for (const row of rows) {
      const account = SEED_ACCOUNTS.find((item) => item.username === row.username)
      if (!account) continue
      this.database.db
        .update(schema.users)
        .set({ approverRoles: rolesFor(account, env) })
        .where(eq(schema.users.id, row.id))
        .run()
    }
  }

  /** 用户被授权的 Workspace。 */
  workspaceIdsOf(userId: string): string[] {
    return this.database.db
      .select({ workspaceId: schema.workspaceMembers.workspaceId })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .all()
      .map((row) => row.workspaceId)
  }

  isMember(userId: string, workspaceId: string): boolean {
    return (
      this.database.db
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.userId, userId),
            eq(schema.workspaceMembers.workspaceId, workspaceId),
          ),
        )
        .get() !== undefined
    )
  }

  /**
   * 可见范围：管理员返回 `null`（不过滤），其他人返回授权的 Workspace。
   *
   * 空数组与 `null` 是两回事——空数组意味着「什么都看不到」。
   */
  workspaceScopeOf(user: AuthUser): string[] | null {
    return user.role === 'admin' ? null : this.workspaceIdsOf(user.id)
  }

  canAccessWorkspace(user: AuthUser, workspaceId: string): boolean {
    return user.role === 'admin' || this.isMember(user.id, workspaceId)
  }

  login(input: {
    username: string
    password: string
    userAgent?: string
    ip?: string
  }): LoginResult {
    const username = input.username.trim()
    const meta = { ip: input.ip ?? null, userAgent: input.userAgent ?? null }
    this.assertNotThrottled(username, meta)

    const row = this.database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.username, username))
      .get()

    // 账号不存在也照常算一次摘要：两条路径的耗时应当接近。
    const passwordOk = verifyPassword(input.password, row?.passwordHash ?? dummyHashOf())

    if (!row || !passwordOk || row.disabled === 1) {
      this.recordFailure(username)
      this.recordAudit({
        event: 'login.failed',
        userId: row?.id ?? null,
        username,
        ...meta,
        reason: !row ? 'unknown-user' : row.disabled === 1 ? 'disabled' : 'bad-password',
      })
      fail(ErrorCode.AUTH_INVALID_CREDENTIALS, '用户名或口令不正确')
    }

    this.failures.delete(username)
    this.sweepExpired()

    const token = randomBytes(32).toString('base64url')
    const issuedAt = this.now()
    const expiresAt = new Date(issuedAt.getTime() + this.ttlMs).toISOString()

    this.database.db
      .insert(schema.authSessions)
      .values({
        id: `asn_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        userId: row.id,
        tokenHash: tokenHashOf(token),
        createdAt: issuedAt.toISOString(),
        expiresAt,
        revokedAt: null,
        userAgent: input.userAgent ?? null,
      })
      .run()

    this.recordAudit({ event: 'login.success', userId: row.id, username, ...meta })

    return { token, expiresAt, user: toUser(row) }
  }

  authenticate(token: string): AuthUser | null {
    if (!token) return null

    const session = this.database.db
      .select()
      .from(schema.authSessions)
      .where(
        and(
          eq(schema.authSessions.tokenHash, tokenHashOf(token)),
          isNull(schema.authSessions.revokedAt),
        ),
      )
      .get()
    if (!session) return null

    // 过期的会话视为不存在；顺手吊销，免得表里堆着永远用不上的行。
    if (Date.parse(session.expiresAt) <= this.now().getTime()) {
      this.revoke(session.id)
      return null
    }

    const user = this.database.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .get()
    if (!user || user.disabled === 1) return null

    return toUser(user)
  }

  logout(token: string, meta: { ip?: string; userAgent?: string } = {}): void {
    const session = this.database.db
      .select({ id: schema.authSessions.id, userId: schema.authSessions.userId })
      .from(schema.authSessions)
      .where(eq(schema.authSessions.tokenHash, tokenHashOf(token)))
      .get()
    if (!session) return

    this.revoke(session.id)

    const user = this.database.db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .get()
    this.recordAudit({
      event: 'logout',
      userId: session.userId,
      username: user?.username ?? 'unknown',
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    })
  }

  /** 最近的登录审计，新的在前。 */
  recentAudit(limit = 50): AuthAuditEntry[] {
    return this.database.db
      .select()
      .from(schema.authAudit)
      .orderBy(desc(schema.authAudit.at))
      .limit(Math.max(1, Math.min(limit, 500)))
      .all()
      .map((row) => ({
        id: row.id,
        event: row.event,
        userId: row.userId,
        username: row.username,
        at: row.at,
        ip: row.ip,
        userAgent: row.userAgent,
        reason: row.reason,
      }))
  }

  /** 批量取显示名，供任务列表回填「发起人」。 */
  displayNamesFor(ids: readonly (string | null)[]): Map<string, string> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
    if (unique.length === 0) return new Map()

    const rows = this.database.db
      .select({ id: schema.users.id, displayName: schema.users.displayName })
      .from(schema.users)
      .where(inArray(schema.users.id, unique))
      .all()

    return new Map(rows.map((row) => [row.id, row.displayName]))
  }

  displayNameOf(userId: string | null): string | null {
    if (!userId) return null
    return this.displayNamesFor([userId]).get(userId) ?? null
  }

  private recordAudit(entry: {
    event: 'login.success' | 'login.failed' | 'logout'
    userId: string | null
    username: string
    ip?: string | null
    userAgent?: string | null
    reason?: string | null
  }): void {
    this.database.db
      .insert(schema.authAudit)
      .values({
        id: `aud_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        event: entry.event,
        userId: entry.userId,
        username: entry.username,
        at: this.now().toISOString(),
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        reason: entry.reason ?? null,
      })
      .run()
  }

  /** 登录会话有效期，供 Cookie 的 maxAge 使用。 */
  get sessionTtlMs(): number {
    return this.ttlMs
  }

  private revoke(id: string): void {
    this.database.db
      .update(schema.authSessions)
      .set({ revokedAt: this.now().toISOString() })
      .where(eq(schema.authSessions.id, id))
      .run()
  }

  private sweepExpired(): void {
    this.database.db
      .delete(schema.authSessions)
      .where(and(isNull(schema.authSessions.revokedAt), lt(schema.authSessions.expiresAt, this.now().toISOString())))
      .run()
  }

  private assertNotThrottled(
    username: string,
    meta: { ip: string | null; userAgent: string | null },
  ): void {
    const entry = this.failures.get(username)
    if (!entry) return
    if (this.now().getTime() >= entry.resetAt) {
      this.failures.delete(username)
      return
    }
    if (entry.count >= this.maxFailures) {
      const seconds = Math.ceil((entry.resetAt - this.now().getTime()) / 1000)
      this.recordAudit({
        event: 'login.failed',
        userId: null,
        username,
        ...meta,
        reason: 'rate-limited',
      })
      fail(
        ErrorCode.AUTH_RATE_LIMITED,
        `登录失败次数过多，请 ${seconds} 秒后再试`,
        { retryAfterSeconds: seconds },
      )
    }
  }

  private recordFailure(username: string): void {
    const nowMs = this.now().getTime()
    const entry = this.failures.get(username)
    if (!entry || nowMs >= entry.resetAt) {
      this.failures.set(username, { count: 1, resetAt: nowMs + this.windowMs })
      return
    }
    entry.count += 1
  }
}
