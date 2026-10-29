/**
 * 审批闸门 —— 「hook 内 await」的实现基础。
 *
 * 决策：审批在 `beforeToolCall` 里原地等待，而不是让整个循环停下来。
 * 好处是恢复语义简单：批准后就是从同一个位置继续，不需要重放调用。
 *
 * 这个类只做一件事：把 `approvalId` 映射到一个挂起的 Promise，
 * 由 `decideApproval` 负责唤醒。**它只在内存里**——跨进程重启的恢复
 * 属于 durable 那一层的事（第 3 步），这里不假装支持。
 */
export type GateDecision = 'granted' | 'denied' | 'expired'

export class ApprovalGate {
  private readonly waiters = new Map<string, (decision: GateDecision) => void>()

  /** 挂起，直到有人对这条审批做出决定。 */
  waitFor(approvalId: string): Promise<GateDecision> {
    return new Promise<GateDecision>((resolve) => {
      // 同一条审批被等待两次说明状态机出了问题，直接覆盖会让前一个 Promise 永远悬空。
      if (this.waiters.has(approvalId)) {
        throw new Error(`审批 ${approvalId} 已经在等待中，不能重复挂起`)
      }
      this.waiters.set(approvalId, resolve)
    })
  }

  /** 唤醒等待者。返回是否确实有人在这个审批上等待。 */
  resolve(approvalId: string, decision: GateDecision): boolean {
    const resolve = this.waiters.get(approvalId)
    if (!resolve) return false
    this.waiters.delete(approvalId)
    resolve(decision)
    return true
  }

  /** 进程关闭时释放所有等待者，避免挂着的 Promise 泄漏。 */
  cancelAll(decision: GateDecision = 'denied'): void {
    for (const [id, resolve] of [...this.waiters]) {
      this.waiters.delete(id)
      resolve(decision)
    }
  }

  get pendingCount(): number {
    return this.waiters.size
  }
}
