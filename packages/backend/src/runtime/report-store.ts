import { eq } from 'drizzle-orm'
import { ErrorCode, fail, type Report } from '@datasentry/core'
import { schema, type Db } from '../db/index.ts'

function toReport(row: typeof schema.reports.$inferSelect): Report {
  return {
    id: row.id,
    sessionId: row.sessionId,
    workspaceId: row.workspaceId,
    draftVersion: row.draftVersion,
    status: row.status,
    ruleVersion: row.ruleVersion,
    metrics: row.metrics,
    conflicts: row.conflicts,
    resultRefs: row.resultRefs,
    dataVersions: row.dataVersions,
    recipientsHash: row.recipientsHash ?? null,
    receiptId: row.receiptId ?? null,
    artifactPath: row.artifactPath ?? null,
    meta: row.meta,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** report 表读写。M4 的发布与回执会在这里补 `status` / `recipientsHash` / `receiptId` 的写入。 */
export class ReportStore {
  constructor(private readonly db: Db) {}

  save(report: Report): Report {
    this.db
      .insert(schema.reports)
      .values({
        id: report.id,
        sessionId: report.sessionId,
        workspaceId: report.workspaceId,
        draftVersion: report.draftVersion,
        status: report.status,
        ruleVersion: report.ruleVersion,
        metrics: report.metrics,
        conflicts: report.conflicts,
        resultRefs: report.resultRefs,
        dataVersions: report.dataVersions,
        recipientsHash: report.recipientsHash,
        receiptId: report.receiptId,
        artifactPath: report.artifactPath,
        meta: report.meta,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.reports.id,
        set: {
          draftVersion: report.draftVersion,
          status: report.status,
          metrics: report.metrics,
          conflicts: report.conflicts,
          recipientsHash: report.recipientsHash,
          receiptId: report.receiptId,
          artifactPath: report.artifactPath,
          meta: report.meta,
          updatedAt: new Date().toISOString(),
        },
      })
      .run()
    return report
  }

  get(id: string): Report | undefined {
    const row = this.db.select().from(schema.reports).where(eq(schema.reports.id, id)).all()[0]
    return row ? toReport(row) : undefined
  }

  require(id: string): Report {
    const report = this.get(id)
    if (!report) fail(ErrorCode.REPORT_NOT_FOUND, `报表不存在：${id}`, { reportId: id })
    return report
  }

  bySession(sessionId: string): Report | undefined {
    const row = this.db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.sessionId, sessionId))
      .all()[0]
    return row ? toReport(row) : undefined
  }

  /**
   * 局部更新。
   *
   * 发布流程会分几步改写同一份报表：先记下接收人摘要（请求确认时），
   * 再记下回执（确认通过并投递后）。分成独立的窄接口，比让调用方
   * 端着一整个 Report 对象来回覆盖要安全得多。
   */
  patch(
    id: string,
    patch: Partial<
      Pick<Report, 'status' | 'draftVersion' | 'recipientsHash' | 'receiptId' | 'meta'>
    >,
  ): Report {
    const current = this.require(id)
    const next: Report = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    this.save(next)
    return next
  }
}
