import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm'
import {
  ApprovalStatus,
  ErrorCode,
  fail,
  newApprovalId,
  type Approval,
} from '@datasentry/core'
import { schema, type Db } from '../db/index.ts'

/** 默认审批有效期。审批不是一次性的通行证，过期作废。 */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

export interface CreateApprovalInput {
  sessionId: string
  workspaceId: string
  toolCallId: string
  toolName: string
  toolVersion: string
  paramsHash: string
  kind: 'tool-call' | 'publish'
  /** 有效期，毫秒。 */
  ttlMs?: number
  /** publish 类审批额外绑定草稿版本与接收人。 */
  draftVersion?: string | null
  recipientsHash?: string | null
}

/** 审批要校验的「被批准对象」。这些字段任一不符，审批即失效。 */
export interface ApprovalSubject {
  toolName: string
  toolVersion: string
  paramsHash: string
}

export type ApprovalVerdict =
  | { ok: true }
  | { ok: false; code: ErrorCode; reason: string }

/**
 * 审批有效性判定（PRD FR-03.3）。
 *
 * 审批不是「同意」这个布尔值，而是一份**绑定**：绑到某个工具、某个版本、
 * 某组参数、一段有效期。任何一项变化都必须重新审批——否则「先批一个只读查询，
 * 再换成导出全量明细」这种审批漂移就会悄无声息地通过。
 *
 * 做成纯函数，是为了让每一条失效路径都能被单独测到，不必构造数据库状态。
 */
export function evaluateApproval(
  approval: Approval,
  subject: ApprovalSubject,
  now: Date = new Date(),
): ApprovalVerdict {
  if (approval.status !== ApprovalStatus.GRANTED) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_INVALID,
      reason: `审批 ${approval.id} 当前状态为 ${approval.status}，不能放行`,
    }
  }

  // 先查有效期：过期的审批即使内容完全匹配也不再有效。
  if (Date.parse(approval.expiresAt) <= now.getTime()) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_EXPIRED,
      reason: `审批 ${approval.id} 已于 ${approval.expiresAt} 过期`,
    }
  }

  if (approval.toolName !== subject.toolName) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_INVALID,
      reason: `审批绑定的是工具 "${approval.toolName}"，与本次调用的 "${subject.toolName}" 不符`,
    }
  }

  if (approval.toolVersion !== subject.toolVersion) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_INVALID,
      reason: `工具 "${subject.toolName}" 的版本已从 ${approval.toolVersion} 变为 ${subject.toolVersion}，审批需重做`,
    }
  }

  if (approval.paramsHash !== subject.paramsHash) {
    return {
      ok: false,
      code: ErrorCode.APPROVAL_PARAMS_DRIFT,
      reason: `调用参数已变更（审批绑定 ${approval.paramsHash.slice(0, 12)}…，本次 ${subject.paramsHash.slice(0, 12)}…），原审批失效`,
    }
  }

  return { ok: true }
}

function toApproval(row: typeof schema.approvals.$inferSelect): Approval {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    toolCallId: row.toolCallId,
    approver: row.approver ?? null,
    toolName: row.toolName,
    toolVersion: row.toolVersion,
    paramsHash: row.paramsHash,
    kind: row.kind,
    draftVersion: row.draftVersion ?? null,
    recipientsHash: row.recipientsHash ?? null,
    status: row.status,
    reason: row.reason ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? null,
  }
}

export class ApprovalStore {
  constructor(private readonly db: Db) {}

  create(input: CreateApprovalInput): Approval {
    const now = new Date()
    const record: Approval = {
      id: newApprovalId(),
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      toolCallId: input.toolCallId,
      approver: null,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      paramsHash: input.paramsHash,
      kind: input.kind,
      draftVersion: input.draftVersion ?? null,
      recipientsHash: input.recipientsHash ?? null,
      status: ApprovalStatus.PENDING,
      reason: null,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_APPROVAL_TTL_MS)).toISOString(),
      createdAt: now.toISOString(),
      decidedAt: null,
    }

    this.db
      .insert(schema.approvals)
      .values({
        id: record.id,
        sessionId: record.sessionId,
        workspaceId: record.workspaceId,
        toolCallId: record.toolCallId,
        approver: null,
        toolName: record.toolName,
        toolVersion: record.toolVersion,
        paramsHash: record.paramsHash,
        kind: record.kind,
        draftVersion: record.draftVersion,
        recipientsHash: record.recipientsHash,
        status: record.status,
        reason: null,
        expiresAt: record.expiresAt,
        createdAt: record.createdAt,
        decidedAt: null,
      })
      .run()

    return record
  }

  get(id: string): Approval | undefined {
    const row = this.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).all()[0]
    return row ? toApproval(row) : undefined
  }

  require(id: string): Approval {
    const approval = this.get(id)
    if (!approval) {
      fail(ErrorCode.APPROVAL_NOT_FOUND, `审批记录不存在：${id}`, { approvalId: id })
    }
    return approval
  }

  byToolCall(toolCallId: string): Approval | undefined {
    const row = this.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.toolCallId, toolCallId))
      .orderBy(desc(schema.approvals.createdAt))
      .all()[0]
    return row ? toApproval(row) : undefined
  }

  listBySession(sessionId: string): Approval[] {
    return this.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.sessionId, sessionId))
      .orderBy(asc(schema.approvals.createdAt))
      .all()
      .map(toApproval)
  }

  /** 待审批队列。审批人看的就是这个列表。 */
  listPending(workspaceId?: string): Approval[] {
    const where = workspaceId
      ? and(
          eq(schema.approvals.status, ApprovalStatus.PENDING),
          eq(schema.approvals.workspaceId, workspaceId),
        )
      : eq(schema.approvals.status, ApprovalStatus.PENDING)

    return this.db
      .select()
      .from(schema.approvals)
      .where(where)
      .orderBy(asc(schema.approvals.createdAt))
      .all()
      .map(toApproval)
  }

  /** 某 Session 上最近一条待审批记录。 */
  latestPending(sessionId: string, kind?: 'tool-call' | 'publish'): Approval | undefined {
    const rows = this.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.sessionId, sessionId),
          eq(schema.approvals.status, ApprovalStatus.PENDING),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .all()

    const filtered = kind ? rows.filter((row) => row.kind === kind) : rows
    return filtered[0] ? toApproval(filtered[0]) : undefined
  }

  /**
   * 记录审批决定。
   *
   * 只记录，**不**触发执行——批准和执行是两件事，由不同的人在不同时刻完成。
   * 批准之后是否能真正执行，还要在恢复时重新校验绑定（见 evaluateApproval）。
   */
  decide(
    id: string,
    decision: { decision: 'granted' | 'denied'; approver: string; reason?: string },
  ): Approval {
    const current = this.require(id)
    if (current.status !== ApprovalStatus.PENDING) {
      this.failAlreadyDecided(id)
    }

    const updated = this.db
      .update(schema.approvals)
      .set({
        status:
          decision.decision === 'granted' ? ApprovalStatus.GRANTED : ApprovalStatus.DENIED,
        approver: decision.approver,
        reason: decision.reason ?? null,
        decidedAt: new Date().toISOString(),
      })
      // 条件更新：两个进程同时决定时，只有一个能命中 pending。
      .where(
        and(eq(schema.approvals.id, id), eq(schema.approvals.status, ApprovalStatus.PENDING)),
      )
      .run()

    if (updated.changes === 0) {
      this.failAlreadyDecided(id)
    }

    return this.require(id)
  }

  private failAlreadyDecided(id: string): never {
    const latest = this.require(id)
    fail(ErrorCode.APPROVAL_INVALID, `审批 ${id} 已经是 ${latest.status}，不能重复决定`, {
      approvalId: id,
      status: latest.status,
    })
  }

  /** 把超期未决的记录标为 expired。返回本次标记的条数。 */
  expireOverdue(now: Date = new Date()): number {
    const result = this.db
      .update(schema.approvals)
      .set({ status: ApprovalStatus.EXPIRED })
      .where(
        and(
          eq(schema.approvals.status, ApprovalStatus.PENDING),
          lt(schema.approvals.expiresAt, now.toISOString()),
        ),
      )
      .run()
    return result.changes
  }

  /** 借据式作废：草稿被重算或接收人变更时，旧的发布确认要显式吊销。 */
  revokePending(sessionId: string, kind: 'publish'): number {
    const result = this.db
      .update(schema.approvals)
      .set({ status: ApprovalStatus.REVOKED, decidedAt: new Date().toISOString() })
      .where(
        and(
          eq(schema.approvals.sessionId, sessionId),
          eq(schema.approvals.kind, kind),
          inArray(schema.approvals.status, [ApprovalStatus.PENDING, ApprovalStatus.GRANTED]),
        ),
      )
      .run()
    return result.changes
  }
}
