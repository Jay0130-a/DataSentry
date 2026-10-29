import { ErrorCode, fail, type Report } from '@datasentry/core'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../../context.ts'
import { PUBLISH_CHANNELS, PUBLISH_FORMATS, PublishFormat, isPublishFormat, type PublishChannel } from '../../reports/publishing.ts'
import { serializeApproval } from './approvals.ts'

/** 发布与回执类接口（FR-06）。 */
export function registerPublishingRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * 发起发布：前置校验 + 生成一份绑定到「草稿版本 + 接收人 + 渠道」的待确认项。
   *
   * 校验不通过时返回 400 而不是先建确认再失败——「发了才发现接收人不在名单里」
   * 是最不该发生的一类事故。
   */
  app.post('/reports/:id/publish', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as {
      recipients?: unknown
      channel?: unknown
      format?: unknown
    }

    if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
      fail(ErrorCode.VALIDATION_FAILED, 'recipients 必须是非空数组')
    }
    const channel = String(body.channel ?? '')
    if (!PUBLISH_CHANNELS.includes(channel as PublishChannel)) {
      fail(
        ErrorCode.VALIDATION_FAILED,
        `channel 必须是 ${PUBLISH_CHANNELS.join(' / ')} 之一，收到 "${channel}"`,
      )
    }
    // 格式决定发出去的是什么文件，缺省时给最常用的 Excel。
    const format = String(body.format ?? PublishFormat.EXCEL)
    if (!isPublishFormat(format)) {
      fail(
        ErrorCode.VALIDATION_FAILED,
        `format 必须是 ${PUBLISH_FORMATS.join(' / ')} 之一，收到 "${format}"`,
      )
    }

    const result = await ctx.requestPublish(id, {
      recipients: body.recipients.map(String),
      channel: channel as PublishChannel,
      format,
    })

    const args = result.toolCall.args as Record<string, unknown>
    return reply.code(202).send({
      approval: serializeApproval(result.approval, null),
      toolCallId: result.toolCall.id,
      report: {
        reportId: result.report.id,
        draftVersion: result.report.draftVersion,
        recipientsHash: result.report.recipientsHash,
      },
      artifact: {
        format: args['format'],
        fileName: args['fileName'],
        sizeBytes: args['sizeBytes'],
        sha256: args['sha256'],
      },
      recipients: result.precheck.recipients,
      warnings: result.precheck.warnings,
      message: '发布确认已创建，等待人工二次确认',
    })
  })

  /**
   * 确认并执行发布。
   *
   * 执行前会重新核对绑定：草稿版本与接收人摘要都必须与批准时一致，
   * 否则以 `APPROVAL_PARAMS_DRIFT` 拒绝——这就是「接收人变化后原确认失效」。
   */
  app.post('/approvals/:id/confirm', async (request) => {
    const { id } = request.params as { id: string }
    const result = await ctx.confirmPublish(id)

    if (result.status === 'pending') {
      return {
        status: 'pending',
        approvalId: result.approvalId,
        message: '该发布确认尚未获批，先调用 POST /approvals/:id/decide',
      }
    }

    if (result.status === 'already-published') {
      return {
        status: 'already-published',
        receiptId: result.receiptId,
        report: {
          reportId: result.report.id,
          sessionId: result.report.sessionId,
          status: result.report.status,
          draftVersion: result.report.draftVersion,
          receiptId: result.report.receiptId,
        },
      }
    }

    const report = result.report
    return {
      status: 'published',
      receipt: result.receipt,
      report: {
        reportId: report.id,
        sessionId: report.sessionId,
        status: report.status,
        draftVersion: report.draftVersion,
        receiptId: report.receiptId,
      },
    }
  })

  /**
   * 结果未知时查回执（FR-06.3）。
   *
   * 针对「网关已投递、本地没记上」那个窗口。这条路由**永远不会重发**：
   * 它只查询、只补齐记账，或者告诉你该转人工。
   */
  app.post('/sessions/:id/reconcile', async (request) => {
    const { id } = request.params as { id: string }
    const result = await ctx.reconcilePublish(id)

    switch (result.status) {
      case 'already-published':
        return { status: result.status, receiptId: result.receiptId }
      case 'reconciled':
        return {
          status: result.status,
          receipt: result.receipt,
          report: { reportId: result.report.id, status: result.report.status },
          message: '网关已有回执，已补齐记账；未重发',
        }
      case 'not-delivered':
        return {
          status: result.status,
          toolCallId: result.toolCallId,
          message: result.reason,
        }
      case 'unknown':
        return { status: result.status, message: result.reason }
    }
  })

  /** 回执查询。 */
  app.get('/reports/:id/receipts', async (request) => {
    const { id } = request.params as { id: string }
    const report = ctx.reports.require(id)

    return {
      reportId: report.id,
      draftVersion: report.draftVersion,
      status: report.status,
      receiptId: report.receiptId,
      receipts: ctx.publishReceipts(report.id).map(({ key: _key, ...rest }) => rest),
    }
  })

  app.get('/reports/:id', async (request) => {
    const { id } = request.params as { id: string }
    return serializeReport(ctx.reports.require(id))
  })
}

function serializeReport(report: Report) {
  return {
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
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  }
}
