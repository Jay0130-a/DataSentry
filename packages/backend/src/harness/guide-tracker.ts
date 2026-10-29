/**
 * 「本 Session 读过哪些 Source 的 guide」。
 *
 * 状态按 Session 隔离而不是全局：换一个任务就该重新读一遍 guide，
 * 否则「先读一次，之后所有任务都算读过」会让 guide 约束形同虚设。
 *
 * 内存缓存之外还有一个**回查**入口：`guide.read` 事件本身就落在事件轨迹里，
 * 所以进程重启后「这个 Session 读过 guide 没有」不用靠新表来记——
 * 审计轨迹本来就是这件事的事实来源。
 */
export class GuideTracker {
  private readonly read = new Map<string, Set<string>>()

  constructor(
    /** 回查实现；通常接到事件轨迹上。返回 true 会被缓存下来。 */
    private readonly lookup?: (sessionId: string, sourceSlug: string) => boolean,
  ) {}

  markRead(sessionId: string, sourceSlug: string): void {
    let set = this.read.get(sessionId)
    if (!set) {
      set = new Set()
      this.read.set(sessionId, set)
    }
    set.add(sourceSlug)
  }

  hasRead(sessionId: string, sourceSlug: string): boolean {
    if (this.read.get(sessionId)?.has(sourceSlug)) return true

    if (this.lookup?.(sessionId, sourceSlug)) {
      this.markRead(sessionId, sourceSlug)
      return true
    }
    return false
  }

  readGuides(sessionId: string): string[] {
    return [...(this.read.get(sessionId) ?? [])].sort()
  }

  /** 会话结束后清理，避免长时间运行的进程里 Map 无限增长。 */
  forget(sessionId: string): void {
    this.read.delete(sessionId)
  }
}
