import { z } from 'zod'
import { approvalStatusSchema, isoTimestamp } from './common.ts'

/**
 * approval：敏感动作审批（PRD FR-03.3 / §7）。
 *
 * 审批不是一个「同意」布尔值，而是一份**绑定**：
 * Workspace + Session + ToolCall + 工具版本 + 参数摘要 + 有效期。
 * 其中任何一项变化，旧审批立即失效——否则「先批一个只读查询，再换成导出全量明细」
 * 这种审批漂移就会悄悄通过。M1 只落表结构，逻辑在 M2 实现。
 */
export const approvalSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  toolCallId: z.string().min(1),
  /** 审批人标识。 */
  approver: z.string().min(1).nullable().default(null),
  /** 绑定：工具名与版本，防止换成同 Source 的另一个工具后复用审批。 */
  toolName: z.string().min(1),
  toolVersion: z.string().min(1),
  /** 绑定：参数规范化摘要。参数一变，hash 不匹配即失效。 */
  paramsHash: z.string().min(1),
  /** 审批类型：敏感取数（M2）或正式发布二次确认（M4）。 */
  kind: z.enum(['tool-call', 'publish']),
  /** 发布审批额外绑定草稿版本与接收人摘要（M4）。 */
  draftVersion: z.string().min(1).nullable().default(null),
  recipientsHash: z.string().min(1).nullable().default(null),
  status: approvalStatusSchema,
  reason: z.string().nullable().default(null),
  expiresAt: isoTimestamp,
  createdAt: isoTimestamp,
  decidedAt: isoTimestamp.nullable().default(null),
})

export type Approval = z.infer<typeof approvalSchema>
