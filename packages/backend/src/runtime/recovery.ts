import {
  ApprovalStatus,
  ErrorCode,
  EventType,
  isTerminal,
  SessionState,
  type Approval,
  type Session,
} from '@datasentry/core'
import type { EventStore } from '../events/event-store.ts'
import type { ApprovalStore } from './approval-store.ts'
import type { CheckpointStore } from './checkpoint.ts'
import type { SessionStore } from './session-store.ts'
import type { ToolCallStore } from './tool-call-store.ts'
import type { ReportStore } from './report-store.ts'

/** `reconcilePublish` 的结论；与 PublishService 的 ReconcileResult 同构。 */
export type ReconcileOutcome =
  | { status: 'already-published'; receiptId: string }
  | { status: 'reconciled'; receiptId: string }
  | { status: 'not-delivered'; reason: string }
  | { status: 'unknown'; reason: string }

/** 恢复扫描对每个非终态会话给出的结论。 */
export type RecoveryAction =
  /** 已终结，不动。 */
  | 'skip-terminal'
  /** BLOCKED / MANUAL_REVIEW / READY —— 等人工或已就绪，不动。 */
  | 'skip-idle'
  /** 显式暂停；`recover --execute` 会从检查点继续。 */
  | 'resume-paused'
  /** 仍在等审批，不动。 */
  | 'awaiting-approval'
  /** 审批已通过：可以重放原 ToolCall。 */
  | 'resume-approved'
  /** 发布确认已通过，等待人工执行「确认投递」——不重放工具调用。 */
  | 'awaiting-publish-confirmation'
  /** 发布已投递但本地没记上：查回执补齐，**不重发**。 */
  | 'resolve-publish'
  /** 审批已否决/过期/吊销：把后果落到会话状态上。 */
  | 'apply-denial'
  /** 执行到一半进程挂了：这条调用的结果未知，标记后转 PAUSED。 */
  | 'mark-interrupted'
  /** 没有悬挂调用，从最后一个检查点继续（转 PAUSED 等待显式恢复）。 */
  | 'continue-from-checkpoint'
  /** 状态自相矛盾，转人工。 */
  | 'needs-manual-review'

export interface RecoveryFinding {
  sessionId: string
  workspaceId: string
  state: Session['state']
  step: number
  stateVersion: number
  /** 最后一个检查点——恢复的锚点。 */
  lastCheckpoint: {
    step: number
    state: Session['state']
    outputRef: string | null
    approvalRef: string | null
  } | null
  /** 悬挂的工具调用（已记录、未出结果）。 */
  pendingToolCall: { id: string; toolName: string; paramsHash: string } | null
  approval: {
    id: string
    kind: string
    status: string
    expiresAt: string
  } | null
  action: RecoveryAction
  reason: string
  /** 已完成的调用数——这些步骤在恢复时不会被重放。 */
  completedSteps: number
}

export interface RecoveryResult {
  findings: RecoveryFinding[]
  /** 本次实际改动了状态的会话。 */
  applied: { sessionId: string; action: RecoveryAction; detail: string }[]
  /** execute=true 时，成功继续执行的会话。 */
  resumed: { sessionId: string; state: string; errorCode: string | null; resultCount: number }[]
  errors: { sessionId: string; message: string }[]
}

/** 这些状态下进程已经不可能还在跑，状态本身是稳定的。 */
const IDLE_STATES: readonly Session['state'][] = [
  // 新建但从未执行：没有残留执行器，也不该由恢复流程替人启动。
  SessionState.INIT,
  SessionState.BLOCKED,
  SessionState.MANUAL_REVIEW,
  SessionState.READY,
]

/**
 * 重启恢复（PRD FR-04）。
 *
 * 处理的是「进程在某个动作中途消失」留下的三类残局：
 *
 * 1. **审批等待中挂掉** —— 状态是稳定的，悬挂的调用与审批都在库里，
 *    审批通过后照常重放。这类任务重启后**什么都不用修**，直接恢复即可。
 * 2. **执行到一半挂掉** —— `tool_call` 停在 `pending`，但我们无法知道
 *    Source 那边到底执行了没有。标记为 `EXECUTION_INTERRUPTED` 后转 PAUSED：
 *    读类 Source 重放是安全的（数据是确定性的），但把「结果未知」这件事
 *    显式记下来，比假装它没发生要诚实。
 * 3. **状态与记录对不上** —— 转人工，不猜。
 *
 * `scan()` 只读；`recover()` 才动状态。分开是为了让运维先看清楚再决定，
 * 而不是一启动就自动执行一堆带副作用的动作。
 */
export class RecoveryService {
  constructor(
    private readonly deps: {
      sessions: SessionStore
      toolCalls: ToolCallStore
      approvals: ApprovalStore
      checkpoints: CheckpointStore
      reports: ReportStore
      events: EventStore
      /**
       * 查回执并补齐发布记账。由 context 注入（它持有 PublishService）。
       * 这个回调**从不**调用发布工具——它存在的意义就是「不重发」。
       */
      reconcilePublish?: (sessionId: string) => Promise<ReconcileOutcome>
    },
  ) {}

  /** 只读扫描。不改任何状态，可以被 API、CLI、启动日志共用。 */
  scan(sessionIds?: readonly string[]): RecoveryFinding[] {
    const sessions = sessionIds
      ? sessionIds.map((id) => this.deps.sessions.require(id))
      : this.deps.sessions.list()

    return sessions.map((session) => this.inspect(session))
  }

  /**
   * 执行恢复。
   *
   * - `execute=false`（默认）：只做**状态收敛**——把不一致的会话挪到 PAUSED /
   *   MANUAL_REVIEW，标记中断的调用。不执行任何 Source 调用。
   * - `execute=true`：在收敛之后，继续执行那些已经可以往下走的会话。
   */
  async recover(
    options: {
      execute?: boolean
      sessionIds?: readonly string[]
      /** 实际执行恢复动作的回调；由 context 注入（它持有 AgentRunner）。 */
      resume?: (sessionId: string) => Promise<{
        state: string
        errorCode: string | null
        resultCount: number
      }>
    } = {},
  ): Promise<RecoveryResult> {
    // 过期审批的写入放在 recover，而不是 scan：扫描要能被页面/启动日志
    // 反复调用而不产生副作用。这里先收敛，后面的分类才看得到真实状态。
    this.deps.approvals.expireOverdue()
    const findings = this.scan(options.sessionIds)
    const result: RecoveryResult = { findings, applied: [], resumed: [], errors: [] }

    for (const finding of findings) {
      try {
        const detail = await this.normalize(finding)
        if (detail) {
          result.applied.push({
            sessionId: finding.sessionId,
            action: finding.action,
            detail,
          })
        }

        const shouldResume =
          options.execute === true &&
          options.resume !== undefined &&
          (finding.action === 'resume-approved' ||
            finding.action === 'resume-paused' ||
            finding.action === 'mark-interrupted' ||
            finding.action === 'continue-from-checkpoint')

        if (shouldResume) {
          const outcome = await options.resume!(finding.sessionId)
          result.resumed.push({
            sessionId: finding.sessionId,
            state: outcome.state,
            errorCode: outcome.errorCode,
            resultCount: outcome.resultCount,
          })
        }
      } catch (err) {
        result.errors.push({
          sessionId: finding.sessionId,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return result
  }

  private inspect(session: Session): RecoveryFinding {
    const { toolCalls, approvals, checkpoints } = this.deps

    const allCalls = toolCalls.listBySession(session.id)
    const pending = allCalls.filter((call) => call.status === 'pending')
    const completedSteps = allCalls.filter((call) => call.status !== 'pending').length
    const lastCheckpoint = checkpoints.latest(session.id) ?? null
    // 多条悬挂调用只可能来自历史脏数据（新请求会结束被取代的旧调用）；
    // 取最新一条，才是当前真正在等的那次。
    const pendingCall = pending[pending.length - 1] ?? null
    const approval = pendingCall ? (approvals.byToolCall(pendingCall.id) ?? null) : null

    const base = {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      state: session.state,
      step: session.step,
      stateVersion: session.stateVersion,
      lastCheckpoint: lastCheckpoint
        ? {
            step: lastCheckpoint.step,
            state: lastCheckpoint.state,
            outputRef: lastCheckpoint.outputRef,
            approvalRef: lastCheckpoint.approvalRef,
          }
        : null,
      pendingToolCall: pendingCall
        ? {
            id: pendingCall.id,
            toolName: pendingCall.toolName,
            paramsHash: pendingCall.paramsHash,
          }
        : null,
      approval: approval
        ? {
            id: approval.id,
            kind: approval.kind,
            status: approval.status,
            expiresAt: approval.expiresAt,
          }
        : null,
      completedSteps,
    }

    const decide = (action: RecoveryAction, reason: string): RecoveryFinding => ({
      ...base,
      action,
      reason,
    })

    /**
     * `apply-denial` 的 finding 必须自带审批记录。
     *
     * 没有悬挂调用时 `base.approval` 是 null，但 normalize 需要按 id 取审批；
     * 之前这里直接把 null 传下去，恢复会在解引用时抛 TypeError，会话永久卡住。
     */
    const decideDenial = (
      action: RecoveryAction,
      reason: string,
      record: Approval,
    ): RecoveryFinding => ({
      ...base,
      approval: {
        id: record.id,
        kind: record.kind,
        status: record.status,
        expiresAt: record.expiresAt,
      },
      action,
      reason,
    })

    if (isTerminal(session.state)) {
      return decide('skip-terminal', `状态 ${session.state} 已终结，无需处理`)
    }
    // 多条悬挂调用只可能来自并发批次/历史脏数据。WAITING_APPROVAL 下可以
    // 转人工复核；其它状态用 mark-interrupted 把全部调用标记为中断后转 PAUSED
    // （FETCHING/COMPUTING/READY 都允许 → PAUSED，不能一律转 MANUAL_REVIEW）。
    if (pending.length > 1) {
      if (session.state === SessionState.WAITING_APPROVAL) {
        return decide(
          'needs-manual-review',
          `存在 ${pending.length} 条悬挂工具调用，无法确定该重放哪一条`,
        )
      }
      return decide(
        'mark-interrupted',
        `存在 ${pending.length} 条悬挂工具调用，结果未知；全部标记为中断后转 PAUSED`,
      )
    }
    if (session.state === SessionState.READY) {
      const report = this.deps.reports.bySession(session.id)
      if (report?.status === 'published') {
        return decide(
          'resolve-publish',
          '报表已发布，但会话仍是 READY——查回执后把状态补齐到 DONE',
        )
      }
    }
    if (IDLE_STATES.includes(session.state)) {
      return decide('skip-idle', `状态 ${session.state} 处于稳定态，等人工推进`)
    }
    if (session.state === SessionState.PAUSED) {
      return decide('resume-paused', '显式暂停；recover --execute 将从检查点继续')
    }

    if (session.state === SessionState.WAITING_APPROVAL) {
      const approvals = this.deps.approvals.listBySession(session.id)
      const latest = approvals[approvals.length - 1] ?? null

      if (!pendingCall) {
        // 没有悬挂调用却在等审批：要么审批已经用掉了，要么状态本身就矛盾。
        // 这时要看的是**最近一条审批**，而不是某条悬挂调用身上的那一条。
        if (!latest) {
          return decide(
            'needs-manual-review',
            '状态是 WAITING_APPROVAL，但既没有悬挂的工具调用也没有审批记录',
          )
        }
        if (latest.status === ApprovalStatus.GRANTED) {
          // 发布类：先去网关查回执，确认到底发出去没有。
          if (latest.kind === 'publish') {
            return decide(
              'resolve-publish',
              `发布确认 ${latest.id} 已通过且调用已完成，但本地没有记账——先查回执，不重发`,
            )
          }
          // 取数类：结果已经落盘，从检查点继续即可。
          return decide(
            'continue-from-checkpoint',
            `审批 ${latest.id} 已通过且调用已完成，结果已落盘，可从检查点继续（已完成 ${completedSteps} 步不会重放）`,
          )
        }
        if (latest.status === ApprovalStatus.PENDING) {
          // scan 不写库，但预览必须和执行结果一致：已过期的 pending 审批
          // 在这里就按「会被过期」分类，而不是显示成还在等审批。
          if (Date.parse(latest.expiresAt) <= Date.now()) {
            return decideDenial(
              'apply-denial',
              `审批 ${latest.id} 已过期（${latest.expiresAt}），需要把后果落到会话状态上`,
              latest,
            )
          }
          return decide(
            'needs-manual-review',
            `状态是 WAITING_APPROVAL，但没有悬挂调用，而审批 ${latest.id} 仍未决——状态与记录不一致`,
          )
        }
        return decideDenial(
          'apply-denial',
          `审批 ${latest.id} 状态为 ${latest.status}，需要把后果落到会话状态上`,
          latest,
        )
      }

      if (!approval) {
        return decide(
          'needs-manual-review',
          `悬挂的工具调用 ${pendingCall.id} 上没有审批记录，无法判断该继续还是停止`,
        )
      }
      switch (approval.status) {
        case ApprovalStatus.GRANTED:
          // 发布确认的执行者是 confirmPublish，不是 agent 循环。
          // 把它标成 resume-approved 会让恢复去重放，等于把报表再算一遍。
          if (approval.kind === 'publish') {
            return decide(
              'awaiting-publish-confirmation',
              `发布确认 ${approval.id} 已通过，等待执行「确认投递」（confirm-publish 会重新核对文件与接收人）`,
            )
          }
          return decide(
            'resume-approved',
            `审批 ${approval.id} 已通过，可重放原 ToolCall（此前已完成 ${completedSteps} 步，不会重放）`,
          )
        case ApprovalStatus.PENDING:
          if (Date.parse(approval.expiresAt) <= Date.now()) {
            return decideDenial(
              'apply-denial',
              `审批 ${approval.id} 已过期（${approval.expiresAt}），需要把后果落到会话状态上`,
              approval,
            )
          }
          return decide(
            'awaiting-approval',
            `审批 ${approval.id} 仍未决，任务继续等待（过期于 ${approval.expiresAt}）`,
          )
        default:
          return decideDenial(
            'apply-denial',
            `审批 ${approval.id} 状态为 ${approval.status}，需要把后果落到会话状态上`,
            approval,
          )
      }
    }

    // 剩下的都是「进程消灭时正处于这些状态」——执行段或计算段中途。
    if (pendingCall) {
      return decide(
        'mark-interrupted',
        `工具调用 ${pendingCall.toolName} 停在 pending，结果未知；标记为中断后转 PAUSED（已完成 ${completedSteps} 步不会重放）`,
      )
    }
    return decide(
      'continue-from-checkpoint',
      lastCheckpoint
        ? `无悬挂调用，可从检查点第 ${lastCheckpoint.step} 步（${lastCheckpoint.state}）继续`
        : '无悬挂调用，也没有检查点，只能从头继续',
    )
  }

  /** 把一条结论落到状态上。返回改动说明；无需改动时返回 null。 */
  private async normalize(finding: RecoveryFinding): Promise<string | null> {
    const { sessions, toolCalls, events } = this.deps
    const session = sessions.require(finding.sessionId)

    switch (finding.action) {
      case 'skip-terminal':
      case 'skip-idle':
      case 'resume-paused':
      case 'awaiting-approval':
      case 'awaiting-publish-confirmation':
      case 'resume-approved':
        return null

      /**
       * 发布结果未知：先去网关查回执。
       *
       * 这一步**总是执行**，不受 `execute` 开关控制——它只读回执文件、
       * 只写本地记账，不产生任何对外动作。把它留给 execute 只会让一份已经
       * 发出去的报表一直停在 `draft`。
       */
      case 'resolve-publish': {
        const reconcile = this.deps.reconcilePublish
        if (!reconcile) return null

        const outcome = await reconcile(session.id)
        switch (outcome.status) {
          case 'already-published': {
            /*
             * `finalizePublish` 先写 report 再转 session。进程在两步之间挂掉时，
             * 报表已经是 published，会话却还停在 WAITING_APPROVAL。
             * 这时 reconcile 会返回 already-published；恢复必须把会话补到 DONE，
             * 否则每次扫描都得出同一个结论、又什么都不做，任务永久卡住。
             */
            const current = sessions.require(session.id)
            if (current.state === SessionState.DONE) return null
            if (
              current.state !== SessionState.WAITING_APPROVAL &&
              current.state !== SessionState.READY
            ) {
              return null
            }
            sessions.transition(current.id, current.stateVersion, SessionState.DONE)
            events.emit({
              sessionId: current.id,
              traceId: current.traceId,
              type: EventType.StateChanged,
              payload: {
                from: current.state,
                to: SessionState.DONE,
                reason: 'recovery:already-published',
                detail: `报表已发布（回执 ${outcome.receiptId}），补齐会话状态`,
              },
            })
            events.emit({
              sessionId: current.id,
              traceId: current.traceId,
              type: EventType.PublishReconciled,
              payload: {
                receiptId: outcome.receiptId,
                reason: '进程在投递记账与状态转移之间中断；报表已发布，补齐会话状态',
              },
            })
            return `报表已发布（回执 ${outcome.receiptId}），已补齐会话状态到 DONE`
          }

          case 'reconciled':
            return `网关已有回执 ${outcome.receiptId}，已补齐记账；未重发`

          case 'not-delivered': {
            if (finding.pendingToolCall) {
              const callId = finding.pendingToolCall.id
              toolCalls.finish(callId, 'failed', {
                denyCode: ErrorCode.EXECUTION_INTERRUPTED,
                denyReason: outcome.reason,
              })
              events.emit({
                sessionId: session.id,
                traceId: session.traceId,
                type: EventType.ToolCallFailed,
                payload: {
                  toolCallId: callId,
                  toolName: finding.pendingToolCall.toolName,
                  status: 'failed',
                  code: ErrorCode.EXECUTION_INTERRUPTED,
                  reason: outcome.reason,
                },
              })
            }
            this.toPaused(session, '发布结果未确认，等待重新确认')
            return `回执不存在，判定未投递：${outcome.reason}`
          }

          case 'unknown': {
            sessions.transition(session.id, session.stateVersion, SessionState.MANUAL_REVIEW, {
              errorCode: ErrorCode.RECEIPT_UNKNOWN,
              errorMessage: outcome.reason,
            })
            events.emit({
              sessionId: session.id,
              traceId: session.traceId,
              type: EventType.StateChanged,
              payload: {
                from: session.state,
                to: SessionState.MANUAL_REVIEW,
                reason: 'recovery:receipt-unknown',
                detail: outcome.reason,
              },
            })
            return `无法判定是否投递成功，已转 MANUAL_REVIEW：${outcome.reason}`
          }
        }
      }

      case 'apply-denial': {
        const approval = this.deps.approvals.require(finding.approval!.id)
        return applyApprovalDenial(this.deps, approval)
      }

      case 'mark-interrupted': {
        // 并发批次可能留下多条悬挂调用；全部标记为中断，避免留下
        // 一条永远处于 pending、又无法被 resume 重放的记录。
        const interrupted = toolCalls.pendingBySession(session.id)
        for (const call of interrupted) {
          toolCalls.finish(call.id, 'failed', {
            denyCode: ErrorCode.EXECUTION_INTERRUPTED,
            denyReason: '进程在本次调用执行期间中断，结果未知；恢复时将重新发起',
          })
          events.emit({
            sessionId: session.id,
            traceId: session.traceId,
            type: EventType.ToolCallFailed,
            payload: {
              toolCallId: call.id,
              toolName: call.toolName,
              status: 'failed',
              code: ErrorCode.EXECUTION_INTERRUPTED,
              reason: '进程中断，结果未知',
            },
          })
        }
        this.toPaused(session, '进程中断，等待恢复')
        return `已把 ${interrupted.length} 条中断的调用标记为 EXECUTION_INTERRUPTED，会话转 PAUSED`
      }

      case 'continue-from-checkpoint': {
        this.toPaused(session, '进程中断，等待从检查点恢复')
        return '会话转 PAUSED，等待显式恢复'
      }

      case 'needs-manual-review': {
        sessions.transition(session.id, session.stateVersion, SessionState.MANUAL_REVIEW, {
          errorCode: ErrorCode.STATE_VERSION_CONFLICT,
          errorMessage: finding.reason,
        })
        events.emit({
          sessionId: session.id,
          traceId: session.traceId,
          type: EventType.StateChanged,
          payload: {
            from: session.state,
            to: SessionState.MANUAL_REVIEW,
            reason: 'recovery:inconsistent-state',
            detail: finding.reason,
          },
        })
        return '状态与记录不一致，已转 MANUAL_REVIEW'
      }
    }
  }

  private toPaused(session: Session, reason: string): void {
    if (session.state === SessionState.PAUSED) return
    this.deps.sessions.transition(session.id, session.stateVersion, SessionState.PAUSED, {
      errorCode: null,
      errorMessage: null,
    })
    this.deps.events.emit({
      sessionId: session.id,
      traceId: session.traceId,
      type: EventType.StateChanged,
      payload: {
        from: session.state,
        to: SessionState.PAUSED,
        reason: 'recovery:interrupted',
        detail: reason,
      },
    })
  }
}

/**
 * 审批被否决/过期/吊销后要落到的状态。
 *
 * 抽成独立函数，是因为它有两个入口：审批人当场决定（`decideApproval`），
 * 以及重启恢复时补记（进程在决定之后、落状态之前挂了）。两处必须走同一套规则，
 * 否则「重新启动一次」就能改变一个任务的结局。
 */
export function applyApprovalDenial(
  deps: {
    sessions: SessionStore
    toolCalls: ToolCallStore
    events: EventStore
  },
  approval: Approval,
): string {
  const { sessions, toolCalls, events } = deps
  const session = sessions.require(approval.sessionId)

  if (approval.kind === 'tool-call') {
    const call = toolCalls.get(approval.toolCallId)
    if (call && call.status === 'pending') {
      toolCalls.finish(call.id, 'denied', {
        denyCode:
          approval.status === ApprovalStatus.EXPIRED
            ? ErrorCode.APPROVAL_EXPIRED
            : ErrorCode.APPROVAL_DENIED,
        denyReason: approval.reason ?? `审批 ${approval.id} 状态为 ${approval.status}`,
      })
      events.emit({
        sessionId: session.id,
        traceId: session.traceId,
        type: EventType.ToolCallFailed,
        payload: {
          toolCallId: call.id,
          toolName: call.toolName,
          status: 'denied',
          code:
            approval.status === ApprovalStatus.EXPIRED
              ? ErrorCode.APPROVAL_EXPIRED
              : ErrorCode.APPROVAL_DENIED,
          reason: approval.reason,
        },
      })
    }
  }

  if (session.state !== SessionState.WAITING_APPROVAL) {
    return `会话状态为 ${session.state}，不是 WAITING_APPROVAL，未改动`
  }

  // 取数审批被拒 → BLOCKED（越权取数是安全事件，必须停下来看）；
  // 发布确认被拒 → 回到 READY（发布被否是业务决定，改一版接收人再走一遍是正常流程）。
  const to = approval.kind === 'publish' ? SessionState.READY : SessionState.BLOCKED
  sessions.transition(session.id, session.stateVersion, to, {
    errorCode:
      approval.kind === 'publish'
        ? null
        : approval.status === ApprovalStatus.EXPIRED
          ? ErrorCode.APPROVAL_EXPIRED
          : ErrorCode.APPROVAL_DENIED,
    errorMessage:
      approval.kind === 'publish'
        ? null
        : (approval.reason ?? `审批 ${approval.id} 状态为 ${approval.status}`),
  })
  events.emit({
    sessionId: session.id,
    traceId: session.traceId,
    type: EventType.StateChanged,
    payload: {
      from: session.state,
      to,
      reason: `approval.${approval.status}`,
      approvalId: approval.id,
    },
  })
  return `审批 ${approval.id} 为 ${approval.status}，会话 ${session.state} → ${to}`
}
