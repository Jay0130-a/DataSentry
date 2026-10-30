import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  ApprovalStatus,
  ErrorCode,
  EventType,
  fail,
  hashValue,
  SessionState,
  type Approval,
  type Report,
  type Session,
  type ToolCall,
} from '@datasentry/core'
import type { AgentRunner } from '../agent/loop.ts'
import type { EventStore } from '../events/event-store.ts'
import type { ApprovalStore } from '../runtime/approval-store.ts'
import type { ReportStore } from '../runtime/report-store.ts'
import type { SessionStore } from '../runtime/session-store.ts'
import type { ToolCallStore } from '../runtime/tool-call-store.ts'
import type { LoadedWorkspace } from '../workspace/loader.ts'
import {
  computeRecipientsHash,
  findImTargetKey,
  precheckPublish,
  type PublishChannel,
  type PublishFormat,
  type PublishPrecheck,
  type PublishRequest,
} from './publishing.ts'
import type { RenderedArtifact } from './renderers/index.ts'

/** 发布工具的完整名。发布走的是与取数完全相同的判定链，因此也需要注册在工具表里。 */
export const PUBLISH_TOOL_NAME = 'mcp__publish__publish_report'

export interface PublishReceiptShape {
  receiptId: string
  reportId: string
  draftVersion: string
  recipients: string[]
  channel: string
  format: string
  fileName: string
  /** 实际投递的字节摘要 */
  sha256: string
  sizeBytes: number
  mimeType: string
  /** 网关投递仓库里的落点 */
  deliveredPath: string
  publishedAt: string
  deduplicated: boolean
}

export interface RequestPublishResult {
  approval: Approval
  toolCall: ToolCall
  report: Report
  precheck: PublishPrecheck
}

export type ConfirmPublishResult =
  | { status: 'pending'; approvalId: string }
  | { status: 'published'; receipt: PublishReceiptShape; report: Report }
  /** 已经投递并记账过：重复确认直接返回，不重放网关调用。 */
  | { status: 'already-published'; receiptId: string; report: Report }

/**
 * 「结果未知」的三种判定（PRD FR-06.3）。
 *
 * - `already-published`：记账已经完成，无事可做
 * - `reconciled`：网关确实收过这一单，只是本地没记上——补齐，**不重发**
 * - `not-delivered`：网关没有回执且调用未完成，可以安全重试
 * - `unknown`：网关没有回执但调用已标记完成，谁也说不准——转人工
 */
export type ReconcileResult =
  | { status: 'already-published'; receiptId: string }
  | { status: 'reconciled'; receipt: PublishReceiptShape; report: Report }
  | { status: 'not-delivered'; reason: string; toolCallId: string }
  | { status: 'unknown'; reason: string }

export interface PublishServiceDeps {
  sessions: SessionStore
  toolCalls: ToolCallStore
  approvals: ApprovalStore
  reports: ReportStore
  events: EventStore
  loadWorkspace: (ref: string) => LoadedWorkspace
  /**
   * 确保 Source 已建立连接、工具已注册。
   *
   * 这一步不能省：审批要绑定**工具版本**，而工具版本来自 Source 的 config + guide 摘要。
   * 没建连接就去绑定，绑到的会是占位值，等真正执行时版本对不上，
   * 一条本该正常的审批会被判成失效。
   */
  prepare: () => Promise<void>
  /** 已注册工具的版本；未注册时返回 undefined。 */
  toolVersionOf: (toolName: string) => string | undefined
  /** 按去重键查发布回执。由 context 接到网关的回执文件上。 */
  findPublishReceipt: (input: PublishDedupeInput) => PublishReceiptShape | undefined
  /**
   * 有没有「发出去了但没记账」的尝试。
   *
   * 有意图、没回执 = 结果未知：可能已经到达对方，也可能没有。
   * 这种情况必须转人工，不能当作「没发过」去重试——重发一封邮件是收不回来的。
   */
  findPublishIntent?: (input: PublishDedupeInput) => boolean
  /**
   * 把草稿渲染成待发布文件。
   *
   * 渲染放在**发起确认时**而不是确认通过后：审批人要知道自己批的是哪一份文件
   * （文件名、大小、内容摘要都进绑定）。等批完再渲染，批的就只是一个「格式」。
   */
  renderReport: (report: Report, format: PublishFormat) => Promise<RenderedArtifact>
  runner: () => Promise<AgentRunner>
  approvalTtlMs?: number
}

/** 回执查询用的去重键输入；字段与网关侧保持一致。 */
export interface PublishDedupeInput {
  reportId: string
  draftVersion: string
  recipients: readonly string[]
  channel: string
  format: string
}

/**
 * 发布流程（PRD FR-06 / FR-03.4）。
 *
 * 分两步，刻意不合成一步：
 *
 * 1. `requestPublish` —— 前置校验 + 生成一份**绑定到具体草稿版本与接收人**的待确认项。
 * 2. `confirmPublish` —— 人工批准之后才真正投递，投递前再把绑定重新核对一遍。
 *
 * 为什么不合：确认和执行之间可能隔着几小时甚至跨天。这段时间里草稿可能被重算、
 * 接收人可能被改——如果确认是一个可以复用的「许可」，它就变成了漂移的入口。
 * 每次投递都必须重新证明「批的就是现在要发的这一份」。
 */
export class PublishService {
  constructor(private readonly deps: PublishServiceDeps) {}

  private emit(
    session: Session,
    type: EventType,
    payload: Record<string, unknown>,
  ): void {
    this.deps.events.emit({ sessionId: session.id, traceId: session.traceId, type, payload })
  }

  /**
   * 新发布请求取代旧确认时，旧的悬挂调用也要结束。
   *
   * 只吊销审批、把 tool_call 留在 pending，会让一个 Session 上堆积多条悬挂调用：
   * 恢复会取到最旧的那条（已被吊销），重启后的 resume 又会因为
   * `pending.length !== 1` 直接失败。审批与调用必须一起收敛。
   */
  private supersedePendingPublishCalls(
    session: Session,
    toolCalls: ToolCallStore,
    approvals: ApprovalStore,
  ): number {
    const pending = approvals
      .listBySession(session.id)
      .filter((approval) => approval.kind === 'publish')
      .map((approval) => toolCalls.get(approval.toolCallId))
      .filter((call): call is ToolCall => call !== undefined && call.status === 'pending')

    for (const call of pending) {
      toolCalls.finish(call.id, 'denied', {
        denyCode: ErrorCode.APPROVAL_INVALID,
        denyReason: '被新的发布请求取代',
      })
      this.emit(session, EventType.ToolCallFailed, {
        toolCallId: call.id,
        toolName: call.toolName,
        status: 'denied',
        code: ErrorCode.APPROVAL_INVALID,
        reason: '被新的发布请求取代',
      })
    }
    return pending.length
  }

  /**
   * 发起发布确认：跑前置校验，把「草稿版本 + 接收人 + 渠道」绑定成一份待确认项。
   *
   * 新的请求会吊销同一 Session 上尚未执行的旧确认——否则改完接收人再确认旧的，
   * 就等于用一份过期授权发给了没被批准的人。
   */
  async requestPublish(reportId: string, request: PublishRequest): Promise<RequestPublishResult> {
    const { reports, sessions, approvals, toolCalls, loadWorkspace } = this.deps

    await this.deps.prepare()
    approvals.expireOverdue()

    const report = reports.require(reportId)
    const session = sessions.require(report.sessionId)
    const workspace = loadWorkspace(session.workspaceId)

    // 只有 READY 的会话可以发起发布；WAITING_APPROVAL 时也只允许替换「发布类」的待确认项，
    // 不能拿发布去盖掉一个正在等待的取数审批。
    if (session.state === SessionState.WAITING_APPROVAL) {
      const pending = approvals.latestPending(session.id)
      if (pending && pending.kind !== 'publish') {
        fail(
          ErrorCode.ILLEGAL_STATE_TRANSITION,
          `Session ${session.id} 正在等待取数审批（${pending.id}），不能同时发起发布确认`,
          { sessionId: session.id, pendingApprovalId: pending.id },
        )
      }
    } else if (session.state !== SessionState.READY) {
      fail(
        ErrorCode.ILLEGAL_STATE_TRANSITION,
        `Session ${session.id} 当前状态为 ${session.state}，只有 READY 的报表可以发布`,
        { sessionId: session.id, state: session.state },
      )
    }

    const precheck = precheckPublish({
      report,
      allowedRecipients: workspace.allowedRecipients,
      imTargets: Object.keys(workspace.imTargets ?? {}),
      request,
      warnings: Array.isArray(report.meta['warnings'])
        ? (report.meta['warnings'] as string[])
        : [],
    })

    if (!precheck.ok) {
      this.emit(session, EventType.PublishConfirmationRequested, {
        reportId: report.id,
        stage: 'precheck-failed',
        failures: precheck.failures,
      })
      fail(ErrorCode.VALIDATION_FAILED, `发布前置校验未通过：${precheck.failures.join('；')}`, {
        reportId: report.id,
        failures: precheck.failures,
      })
    }

    /*
     * 先把文件渲染出来，再生成确认。
     *
     * 顺序很关键：审批人看到的应当是**具体那一份文件**——
     * 文件名、大小、内容摘要都写进绑定。若等确认通过后再渲染，
     * 审批批到的只是一个「格式」，而不是「这份文件」。
     */
    const rendered = await this.deps.renderReport(report, request.format)

    const recipientsHash = computeRecipientsHash({
      recipients: precheck.recipients,
      channel: request.channel,
      format: request.format,
    })
    const updatedReport = reports.patch(report.id, { recipientsHash })

    const imTargetKey =
      request.channel === 'im'
        ? findImTargetKey(workspace.imTargets, precheck.recipients[0] ?? '')
        : null

    const args = {
      reportId: report.id,
      draftVersion: report.draftVersion,
      recipients: precheck.recipients,
      channel: request.channel,
      format: request.format,
      fileName: rendered.fileName,
      artifactPath: rendered.path,
      sha256: rendered.sha256,
      sizeBytes: rendered.sizeBytes,
      mimeType: rendered.mimeType,
      // 邮件标题与正文要用：网关据此组装，不必再回查 Session。
      period: String(session.input['period'] ?? ''),
      workspaceName: workspace.name,
      // IM 渠道：传目标名与「凭据变量名」，不传密钥本身——
      // args 会进 tool_call 表与事件轨迹，密钥不能出现在那里。
      ...(request.channel === 'im'
        ? {
            imTarget: imTargetKey ?? precheck.recipients[0] ?? '',
            imCredentialKey: imTargetKey
              ? (workspace.imTargets?.[imTargetKey]?.credentialKey ?? '')
              : '',
          }
        : {}),
    }
    const toolName = PUBLISH_TOOL_NAME
    const toolVersion = this.deps.toolVersionOf(toolName)
    if (!toolVersion) {
      // 宁可直接报错，也不要绑一个占位版本——那会让审批在真正执行时莫名其妙地失效。
      fail(ErrorCode.TOOL_NOT_REGISTERED, `发布工具 ${toolName} 未注册，无法生成发布确认`, {
        toolName,
      })
    }

    /*
     * 新请求取代旧确认：审批和它挂着的调用一起收敛。
     *
     * 必须放在渲染与工具版本检查**之后**：替换请求本身失败（渲染报错、
     * 工具未注册）时，旧的确认应当原样保留，而不是先被拆掉再报错。
     */
    const supersededCalls = this.supersedePendingPublishCalls(session, toolCalls, approvals)
    const revoked = approvals.revokePending(session.id, 'publish')

    const toolCall = toolCalls.create({
      sessionId: session.id,
      step: session.step,
      toolName,
      sourceSlug: 'publish',
      paramsHash: hashValue(args),
      toolVersion,
      args,
    })

    const approval = approvals.create({
      sessionId: session.id,
      workspaceId: workspace.id,
      toolCallId: toolCall.id,
      toolName,
      toolVersion: toolCall.toolVersion,
      paramsHash: toolCall.paramsHash,
      kind: 'publish',
      draftVersion: report.draftVersion,
      recipientsHash,
      ...(this.deps.approvalTtlMs !== undefined ? { ttlMs: this.deps.approvalTtlMs } : {}),
    })

    this.emit(session, EventType.PublishConfirmationRequested, {
      approvalId: approval.id,
      toolCallId: toolCall.id,
      reportId: report.id,
      draftVersion: report.draftVersion,
      recipients: precheck.recipients,
      channel: request.channel,
      recipientsHash,
      superseded: revoked,
      supersededCalls,
      expiresAt: approval.expiresAt,
      warnings: precheck.warnings,
    })

    if (session.state === SessionState.READY) {
      this.transition(session, SessionState.WAITING_APPROVAL)
    }

    return { approval, toolCall, report: updatedReport, precheck }
  }

  /**
   * 确认并执行发布。
   *
   * 执行前把绑定重新核对一遍：草稿版本、接收人摘要都必须与批准时一致。
   * 这两条不是冗余检查——它们正是「接收人变了确认就失效」这句需求的实现。
   */
  async confirmPublish(approvalId: string): Promise<ConfirmPublishResult> {
    const { approvals, reports, sessions, toolCalls } = this.deps

    await this.deps.prepare()
    approvals.expireOverdue()
    const approval = approvals.require(approvalId)

    if (approval.kind !== 'publish') {
      fail(ErrorCode.APPROVAL_INVALID, `审批 ${approvalId} 不是发布确认`, { approvalId })
    }

    const session = sessions.require(approval.sessionId)
    const toolCall = toolCalls.require(approval.toolCallId)
    const reportId = String(toolCall.args['reportId'])
    const report = reports.require(reportId)

    // 幂等：已经发布过的报表不再执行网关调用，也不重复写事件。
    // 这条要排在审批状态检查之前——首次发布后审批可能已过期/被吊销，
    // 重复确认仍应返回「已发布」，而不是一个看起来像失败的错误。
    if (report.status === 'published') {
      this.convergePublishedSession(session)
      return {
        status: 'already-published',
        receiptId: report.receiptId ?? '',
        report,
      }
    }

    if (approval.status === ApprovalStatus.PENDING) {
      return { status: 'pending', approvalId }
    }

    // 人工复核/失败/阻塞等状态不能继续投递：审批记录还在，但任务已经被关掉。
    if (session.state !== SessionState.WAITING_APPROVAL) {
      fail(
        ErrorCode.ILLEGAL_STATE_TRANSITION,
        `Session ${session.id} 当前状态为 ${session.state}，不能确认发布`,
        { sessionId: session.id, state: session.state, approvalId },
      )
    }

    if (approval.status !== ApprovalStatus.GRANTED) {
      fail(
        approval.status === ApprovalStatus.EXPIRED
          ? ErrorCode.APPROVAL_EXPIRED
          : ErrorCode.APPROVAL_INVALID,
        `发布确认 ${approvalId} 当前状态为 ${approval.status}，不能执行`,
        { approvalId, status: approval.status },
      )
    }

    // —— 绑定复核：批准的是不是现在要发的这一份 ——
    if (report.draftVersion !== approval.draftVersion) {
      fail(
        ErrorCode.APPROVAL_PARAMS_DRIFT,
        `草稿已从 ${approval.draftVersion} 变为 ${report.draftVersion}，原发布确认失效`,
        { approvalId, approvedDraft: approval.draftVersion, currentDraft: report.draftVersion },
      )
    }

    if (report.recipientsHash !== approval.recipientsHash) {
      fail(
        ErrorCode.APPROVAL_PARAMS_DRIFT,
        '接收人、渠道或格式已变更，原发布确认失效，需要重新确认',
        {
          approvalId,
          approvedRecipientsHash: approval.recipientsHash,
          currentRecipientsHash: report.recipientsHash,
        },
      )
    }

    /*
     * 文件字节校验。
     *
     * 绑定摘要防的是「参数变了」，防不了「同一个路径上的文件被替换」。
     * 审批批的是 sha256 承诺的那几个字节，发出去的就必须是那几个字节。
     */
    const artifactPath = String(toolCall.args['artifactPath'] ?? '')
    const approvedSha = String(toolCall.args['sha256'] ?? '')
    if (!artifactPath || !approvedSha) {
      fail(ErrorCode.APPROVAL_INVALID, '发布确认缺少文件绑定（artifactPath / sha256）', {
        approvalId,
        toolCallId: toolCall.id,
      })
    }

    let actualSha: string
    try {
      actualSha = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
    } catch {
      fail(ErrorCode.APPROVAL_PARAMS_DRIFT, `待发布文件不存在或不可读：${artifactPath}`, {
        approvalId,
        artifactPath,
      })
    }

    if (actualSha !== approvedSha) {
      fail(ErrorCode.APPROVAL_PARAMS_DRIFT, '待发布文件的内容已变化，原发布确认失效', {
        approvalId,
        artifactPath,
        approvedSha,
        actualSha,
      })
    }

    const runner = await this.deps.runner()
    const executed = await runner.executeApprovedCall(
      session.id,
      toolCall.id,
      '发布二次确认已通过',
      { allowPublish: true },
    )

    const receipt = executed.result?.data as PublishReceiptShape | undefined
    if (!receipt?.receiptId) {
      fail(ErrorCode.RECEIPT_UNKNOWN, '发布网关没有返回回执编号', { approvalId })
    }

    const published = this.finalizePublish({
      session,
      report,
      approvalId,
      receipt,
      source: 'confirmed',
    })

    return { status: 'published', receipt, report: published }
  }

  /**
   * 结果未知时先查回执（PRD FR-06.3）。
   *
   * 针对的是那个窄窗口：网关已经投递、进程在写回 `report.receiptId` 之前挂掉。
   * 重启后报表还是 `draft`，但回执文件里已经有这一单——**重发会发两次**，
   * 所以必须先查。
   *
   * 三种结论，对应三种正确动作：补记账、安全重试、转人工。
   * 注意这里**从不**调用发布工具——这个方法的存在就是为了不重发。
   */
  async reconcilePublish(sessionId: string): Promise<ReconcileResult> {
    const { sessions, reports, approvals, toolCalls } = this.deps

    await this.deps.prepare()
    const session = sessions.require(sessionId)
    const report = reports.bySession(sessionId)

    if (!report) {
      fail(ErrorCode.RECEIPT_UNKNOWN, `Session ${sessionId} 没有产出报表，无从核对发布结果`)
    }
    if (report.status === 'published') {
      return { status: 'already-published', receiptId: report.receiptId ?? '' }
    }

    const publishApprovals = approvals
      .listBySession(sessionId)
      .filter((approval) => approval.kind === 'publish')

    if (publishApprovals.length === 0) {
      return { status: 'unknown', reason: '该任务从未发起过发布确认' }
    }

    // 从最近一次发布请求往回找：找到网关确实收过的那一单就补记账。
    for (const approval of [...publishApprovals].reverse()) {
      const call = toolCalls.get(approval.toolCallId)
      if (!call) continue

      const lookup = {
        reportId: String(call.args['reportId'] ?? ''),
        draftVersion: String(call.args['draftVersion'] ?? ''),
        recipients: Array.isArray(call.args['recipients'])
          ? (call.args['recipients'] as unknown[]).map(String)
          : [],
        channel: String(call.args['channel'] ?? ''),
        format: String(call.args['format'] ?? ''),
      }

      const receipt = this.deps.findPublishReceipt(lookup)
      if (!receipt) {
        // 发过、但没留下回执：结果未知，交给人判断，绝不自动重发。
        if (this.deps.findPublishIntent?.(lookup)) {
          return {
            status: 'unknown',
            reason:
              '上一次投递已经发出但没留下回执，无法确认对方是否收到；转人工核对（不重发）',
          }
        }
        continue
      }

      // 网关有回执 = 已经发出去过。补齐本地记账，绝不重发。
      const patched = this.finalizePublish({
        session,
        report,
        approvalId: approval.id,
        receipt: { ...receipt, deduplicated: true },
        source: 'reconciled',
      })
      return {
        status: 'reconciled',
        receipt: { ...receipt, deduplicated: true },
        report: patched,
      }
    }

    const latest = publishApprovals[publishApprovals.length - 1]!
    const latestCall = toolCalls.get(latest.toolCallId)

    if (latestCall?.status === 'pending') {
      return {
        status: 'not-delivered',
        reason: '网关没有该次投递的回执，且调用尚未完成——可以安全重试',
        toolCallId: latestCall.id,
      }
    }

    return {
      status: 'unknown',
      reason: `网关没有回执，但调用 ${latestCall?.id ?? '(缺失)'} 已标记为 ${latestCall?.status ?? '未知'}，无法判定是否投递成功`,
    }
  }

  /**
   * 发布成功之后的记账：产物状态、回执、事件、会话状态。
   *
   * `confirmPublish` 与 `reconcilePublish` 共用它——两条路径的**结果状态必须完全一致**，
   * 否则「重启一次」就能让同一份发布留下不同的本地记录。
   */
  private finalizePublish(input: {
    session: Session
    report: Report
    approvalId: string
    receipt: PublishReceiptShape
    source: 'confirmed' | 'reconciled'
  }): Report {
    const { reports, sessions } = this.deps
    const { session, report, approvalId, receipt, source } = input

    const published = reports.patch(report.id, {
      status: 'published',
      receiptId: receipt.receiptId,
    })

    this.emit(session, EventType.PublishExecuted, {
      approvalId,
      reportId: report.id,
      draftVersion: report.draftVersion,
      recipients: receipt.recipients,
      channel: receipt.channel,
      deduplicated: receipt.deduplicated,
      source,
    })
    this.emit(session, EventType.ReceiptReceived, {
      receiptId: receipt.receiptId,
      reportId: report.id,
      draftVersion: report.draftVersion,
      publishedAt: receipt.publishedAt,
      deduplicated: receipt.deduplicated,
      source,
    })
    if (source === 'reconciled') {
      this.emit(session, EventType.PublishReconciled, {
        approvalId,
        reportId: report.id,
        receiptId: receipt.receiptId,
        reason: '进程在投递与记账之间中断，已按回执补齐；未重发',
      })
    }

    const current = sessions.require(session.id)
    if (current.state === SessionState.WAITING_APPROVAL) {
      this.transition(current, SessionState.DONE)
    }
    return published
  }

  /**
   * 报表已发布但会话还停在 WAITING_APPROVAL/READY（崩溃窗口的残留）时补到 DONE。
   *
   * 重复确认不应该因为「上次已经发过了」就留下一个永远等审批的会话。
   */
  private convergePublishedSession(session: Session): void {
    const current = this.deps.sessions.require(session.id)
    if (current.state === SessionState.DONE) return
    if (
      current.state !== SessionState.WAITING_APPROVAL &&
      current.state !== SessionState.READY
    ) {
      return
    }
    this.deps.sessions.transition(current.id, current.stateVersion, SessionState.DONE)
    this.emit(current, EventType.StateChanged, {
      from: current.state,
      to: SessionState.DONE,
      reason: 'publish:already-published',
    })
  }

  private transition(session: Session, to: Session['state']): Session {
    const updated = this.deps.sessions.transition(session.id, session.stateVersion, to)
    this.emit(updated, EventType.StateChanged, {
      from: session.state,
      to,
      step: updated.step,
      stateVersion: updated.stateVersion,
    })
    return updated
  }
}

export type { PublishChannel }
