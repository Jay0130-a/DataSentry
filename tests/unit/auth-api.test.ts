import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { hashValue } from '@datasentry/core'
import { hashPassword } from '@datasentry/backend/auth/password.ts'
import { createAppContext, type AppContext } from '@datasentry/backend/context.ts'
import { buildServer } from '@datasentry/backend/server/app.ts'
import { tempPaths, type TempPaths } from '../helpers/tmp.ts'

let temp: TempPaths
let ctx: AppContext
let app: FastifyInstance

beforeAll(async () => {
  temp = tempPaths('datasentry-auth-api-')
  ctx = await createAppContext({ paths: temp.paths, modelProvider: 'mock' })
  // 用固定口令建号，避免依赖进程环境里的默认口令。
  // 业务用户只授权 group-finance——retail-analytics 用来验证跨 Workspace 被拒。
  ctx.auth.ensureSeeded(
    {
      DATASENTRY_ADMIN_PASSWORD: 'admin-pass',
      DATASENTRY_ANALYST_PASSWORD: 'analyst-pass',
    },
    ['group-finance', 'retail-analytics'],
  )
  app = buildServer(ctx, { seedUsers: false })
})

afterAll(async () => {
  await app?.close()
  await ctx?.close()
  temp?.cleanup()
})

async function loginAs(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username, password },
  })
  expect(response.statusCode, response.body).toBe(200)

  const raw = response.headers['set-cookie']
  const value = Array.isArray(raw) ? raw[0] : raw
  expect(value, '登录响应必须带 set-cookie').toBeTruthy()
  return String(value).split(';')[0] ?? ''
}

describe('HTTP 鉴权', () => {
  it('/health 不需要登录', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
  })

  it('没有会话访问业务接口返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/sessions' })
    expect(response.statusCode).toBe(401)
    expect(JSON.parse(response.body).error.code).toBe('UNAUTHENTICATED')
  })

  it('登录后可以访问业务接口', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')
    const response = await app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
  })

  it('业务用户访问数据源与恢复接口返回 403', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')

    for (const url of ['/sources', '/tools', '/recovery']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } })
      expect(response.statusCode, url).toBe(403)
      expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN')
    }
  })

  it('管理员可以访问数据源清单', async () => {
    const cookie = await loginAs('admin', 'admin-pass')
    const response = await app.inject({ method: 'GET', url: '/sources', headers: { cookie } })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).length).toBeGreaterThan(0)
  })

  it('口令错误返回 401，且不透露账号是否存在', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'nope' },
    })
    const ghost = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'ghost', password: 'nope' },
    })

    expect(wrong.statusCode).toBe(401)
    expect(ghost.statusCode).toBe(401)
    expect(JSON.parse(wrong.body).error.code).toBe('AUTH_INVALID_CREDENTIALS')
    expect(JSON.parse(ghost.body).error.message).toBe(JSON.parse(wrong.body).error.message)
  })

  it('登出之后旧 Cookie 立刻失效', async () => {
    const cookie = await loginAs('admin', 'admin-pass')

    const before = await app.inject({ method: 'GET', url: '/sessions', headers: { cookie } })
    expect(before.statusCode).toBe(200)

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    })
    expect(logout.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: '/sessions', headers: { cookie } })
    expect(after.statusCode).toBe(401)
  })

  it('/auth/me 返回当前身份', async () => {
    const cookie = await loginAs('admin', 'admin-pass')
    const response = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).user.role).toBe('admin')
  })
})

describe('Workspace 边界：任务不是全员可见', () => {
  function createIn(workspace: string): { id: string } {
    return ctx.createSession({
      workspace,
      request: '出 2025-09 的经营月报',
      input: { period: '2025-09' },
    })
  }

  it('业务用户只看到自己授权的 Workspace', async () => {
    const mine = createIn('group-finance')
    const other = createIn('retail-analytics')
    const cookie = await loginAs('analyst', 'analyst-pass')

    const response = await app.inject({ method: 'GET', url: '/sessions', headers: { cookie } })
    expect(response.statusCode).toBe(200)

    const rows = JSON.parse(response.body) as { id: string; workspaceId: string }[]
    expect(rows.map((row) => row.id)).toContain(mine.id)
    expect(rows.map((row) => row.id)).not.toContain(other.id)
    expect(rows.every((row) => row.workspaceId === 'group-finance')).toBe(true)
  })

  it('直接访问别的 Workspace 的任务被拒——列表藏起来不算边界', async () => {
    const other = createIn('retail-analytics')
    const cookie = await loginAs('analyst', 'analyst-pass')

    for (const url of [`/sessions/${other.id}`, `/sessions/${other.id}/events`, `/sessions/${other.id}/report`]) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } })
      expect(response.statusCode, url).toBe(403)
      expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN')
    }
  })

  it('向未授权的 Workspace 发起任务被拒', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')
    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { cookie },
      payload: { workspace: 'retail-analytics', request: '出 2025-09 的经营月报' },
    })

    expect(response.statusCode).toBe(403)
    expect(JSON.parse(response.body).error.code).toBe('FORBIDDEN')
  })

  it('发起任务会记下发起人', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')
    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { cookie },
      payload: { workspace: 'group-finance', request: '出 2025-09 的经营月报' },
    })

    expect(response.statusCode).toBe(201)
    const body = JSON.parse(response.body) as { createdBy: string | null }
    const analyst = ctx.database.sqlite
      .prepare("SELECT id FROM user WHERE username = 'analyst'")
      .get() as { id: string }
    expect(body.createdBy).toBe(analyst.id)
  })

  it('管理员看得到全部 Workspace', async () => {
    const other = createIn('retail-analytics')
    const cookie = await loginAs('admin', 'admin-pass')

    const response = await app.inject({ method: 'GET', url: '/sessions', headers: { cookie } })
    const rows = JSON.parse(response.body) as { id: string }[]
    expect(rows.map((row) => row.id)).toContain(other.id)
  })

  it('审批队列同样按 Workspace 过滤', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')
    const response = await app.inject({ method: 'GET', url: '/approvals', headers: { cookie } })

    expect(response.statusCode).toBe(200)
    const rows = JSON.parse(response.body) as { workspaceId: string }[]
    expect(rows.every((row) => row.workspaceId === 'group-finance')).toBe(true)
  })
})

describe('审批人 = 登录身份', () => {
  function pendingApproval(): { approvalId: string } {
    const session = ctx.createSession({
      workspace: 'group-finance',
      request: '出 2025-09 的经营月报',
      input: { period: '2025-09' },
    })
    const args = { period: '2025-09' }
    const paramsHash = hashValue(args)
    const call = ctx.toolCalls.create({
      sessionId: session.id,
      step: 0,
      toolName: 'mcp__finance__fetch_expense_detail',
      sourceSlug: 'finance',
      paramsHash,
      toolVersion: 'v-test',
      args,
    })
    const approval = ctx.approvals.create({
      sessionId: session.id,
      workspaceId: 'group-finance',
      toolCallId: call.id,
      toolName: call.toolName,
      toolVersion: 'v-test',
      paramsHash,
      kind: 'tool-call',
    })
    return { approvalId: approval.id }
  }

  it('审批人取自登录身份，请求体里的名字不被采信', async () => {
    const { approvalId } = pendingApproval()
    const cookie = await loginAs('analyst', 'analyst-pass')

    const response = await app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: { cookie },
      payload: { decision: 'granted', approver: '伪造的审批人' },
    })
    expect(response.statusCode, response.body).toBe(200)

    const row = ctx.database.sqlite
      .prepare('SELECT approver FROM approval WHERE id = ?')
      .get(approvalId) as { approver: string }
    expect(row.approver).toBe('业务用户')
  })

  it('未登录不能审批', async () => {
    const { approvalId } = pendingApproval()
    const response = await app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      payload: { decision: 'granted' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('发起人的显示名会回填到任务上', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')
    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { cookie },
      payload: { workspace: 'group-finance', request: '出 2025-09 的经营月报' },
    })

    expect(response.statusCode).toBe(201)
    const body = JSON.parse(response.body) as { createdByName: string | null }
    expect(body.createdByName).toBe('业务用户')
  })

  it('登录审计只有管理员能看', async () => {
    const analyst = await loginAs('analyst', 'analyst-pass')
    const denied = await app.inject({
      method: 'GET',
      url: '/auth/audit',
      headers: { cookie: analyst },
    })
    expect(denied.statusCode).toBe(403)

    const admin = await loginAs('admin', 'admin-pass')
    const allowed = await app.inject({
      method: 'GET',
      url: '/auth/audit',
      headers: { cookie: admin },
    })
    expect(allowed.statusCode).toBe(200)

    const rows = JSON.parse(allowed.body) as { event: string; username: string }[]
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => row.event === 'login.success')).toBe(true)
  })
})

describe('审批资格：谁能批', () => {
  function userIdOf(username: string): string {
    const row = ctx.database.sqlite
      .prepare('SELECT id FROM user WHERE username = ?')
      .get(username) as { id: string }
    return row.id
  }

  function approvalFor(createdBy: string | null): { approvalId: string } {
    const session = ctx.createSession(
      {
        workspace: 'group-finance',
        request: '出 2025-09 的经营月报',
        input: { period: '2025-09' },
      },
      createdBy ? { userId: createdBy } : undefined,
    )

    const args = { period: '2025-09' }
    const paramsHash = hashValue(args)
    const call = ctx.toolCalls.create({
      sessionId: session.id,
      step: 0,
      toolName: 'mcp__finance__fetch_expense_detail',
      sourceSlug: 'finance',
      paramsHash,
      toolVersion: 'v-test',
      args,
    })

    const approval = ctx.approvals.create({
      sessionId: session.id,
      workspaceId: 'group-finance',
      toolCallId: call.id,
      toolName: call.toolName,
      toolVersion: 'v-test',
      paramsHash,
      kind: 'tool-call',
    })
    return { approvalId: approval.id }
  }

  function decide(approvalId: string, cookie: string) {
    return app.inject({
      method: 'POST',
      url: `/approvals/${approvalId}/decide`,
      headers: { cookie },
      payload: { decision: 'granted' },
    })
  }

  it('不能批准自己发起的任务', async () => {
    const analystId = userIdOf('analyst')
    const { approvalId } = approvalFor(analystId)
    const cookie = await loginAs('analyst', 'analyst-pass')

    const response = await decide(approvalId, cookie)
    expect(response.statusCode, response.body).toBe(403)
    expect(JSON.parse(response.body).error.code).toBe('APPROVAL_SELF_DENIED')
  })

  it('有资格的其他人可以批准', async () => {
    const { approvalId } = approvalFor(userIdOf('analyst'))
    const cookie = await loginAs('admin', 'admin-pass')

    const response = await decide(approvalId, cookie)
    expect(response.statusCode, response.body).toBe(200)
  })

  it('没有审批角色的人被拒，并被告知缺什么角色', async () => {
    ctx.database.sqlite
      .prepare(
        `INSERT OR IGNORE INTO user
           (id, username, display_name, role, password_hash, approver_roles, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        'usr_viewer',
        'viewer',
        '只读用户',
        'analyst',
        hashPassword('viewer-pass'),
        '[]',
        new Date().toISOString(),
      )
    ctx.database.sqlite
      .prepare('INSERT OR IGNORE INTO workspace_member (user_id, workspace_id, created_at) VALUES (?, ?, ?)')
      .run('usr_viewer', 'group-finance', new Date().toISOString())

    // 没有发起人，排除职责分离的干扰——要验证的是「资格」这一条
    const { approvalId } = approvalFor(null)
    const cookie = await loginAs('viewer', 'viewer-pass')

    const response = await decide(approvalId, cookie)
    expect(response.statusCode).toBe(403)

    const error = JSON.parse(response.body).error
    expect(error.code).toBe('APPROVAL_NOT_AUTHORIZED')
    expect(error.details.requiredRoles).toEqual(['finance-approver', 'cfo'])
  })

  it('列表里直接带出「你能不能批」的结论', async () => {
    const { approvalId } = approvalFor(userIdOf('analyst'))
    const cookie = await loginAs('analyst', 'analyst-pass')

    const response = await app.inject({ method: 'GET', url: '/approvals', headers: { cookie } })
    const rows = JSON.parse(response.body) as {
      id: string
      authority: { allowed: boolean; code: string | null } | null
    }[]

    const mine = rows.find((row) => row.id === approvalId)
    expect(mine?.authority?.allowed).toBe(false)
    expect(mine?.authority?.code).toBe('APPROVAL_SELF_DENIED')
  })
})

describe('资源不存在的状态码', () => {
  it('不存在的报表返回 404，而不是 500', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')
    const response = await app.inject({
      method: 'GET',
      url: '/reports/rpt_nope',
      headers: { cookie },
    })

    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body).error.code).toBe('REPORT_NOT_FOUND')
  })

  it('不存在的审批返回 404，而不是 500', async () => {
    const cookie = await loginAs('analyst', 'analyst-pass')
    const response = await app.inject({
      method: 'POST',
      url: '/approvals/apv_nope/decide',
      headers: { cookie },
      payload: { decision: 'granted' },
    })

    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body).error.code).toBe('APPROVAL_NOT_FOUND')
  })

  it('向不存在的 Workspace 发起任务返回 404', async () => {
    const cookie = await loginAs('admin', 'admin-pass')
    const response = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: { cookie },
      payload: { workspace: 'no-such-ws', request: '出 2025-09 的经营月报' },
    })

    expect(response.statusCode).toBe(404)
    expect(JSON.parse(response.body).error.code).toBe('WORKSPACE_NOT_FOUND')
  })

  it('重复决定同一个审批返回 409，而不是 500', async () => {
    const session = ctx.createSession(
      { workspace: 'group-finance', request: '出 2025-09 的经营月报', input: { period: '2025-09' } },
      { userId: (ctx.database.sqlite.prepare("SELECT id FROM user WHERE username = 'analyst'").get() as { id: string }).id },
    )
    const args = { period: '2025-09' }
    const paramsHash = hashValue(args)
    const call = ctx.toolCalls.create({
      sessionId: session.id,
      step: 0,
      toolName: 'mcp__finance__fetch_expense_detail',
      sourceSlug: 'finance',
      paramsHash,
      toolVersion: 'v-test',
      args,
    })
    const approval = ctx.approvals.create({
      sessionId: session.id,
      workspaceId: 'group-finance',
      toolCallId: call.id,
      toolName: call.toolName,
      toolVersion: 'v-test',
      paramsHash,
      kind: 'tool-call',
    })

    const cookie = await loginAs('admin', 'admin-pass')
    const first = await app.inject({
      method: 'POST',
      url: `/approvals/${approval.id}/decide`,
      headers: { cookie },
      payload: { decision: 'granted' },
    })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({
      method: 'POST',
      url: `/approvals/${approval.id}/decide`,
      headers: { cookie },
      payload: { decision: 'granted' },
    })
    expect(second.statusCode).toBe(409)
    expect(JSON.parse(second.body).error.code).toBe('APPROVAL_INVALID')
  })
})
