import { z } from 'zod'
import { isoTimestamp, permissionModeSchema } from './common.ts'

/**
 * workspace：管长期配置（PRD §7）。
 *
 * 注意：Workspace 是配置与工具的访问边界，**不是**数据库行级权限。
 * 数据平台的行级隔离是另一层，两者边界需在代码与文档中都写清楚。
 */
/**
 * 指标输入：从哪个工具、取哪个字段。
 *
 * 只描述输入，不描述公式——公式是业务口径，仍在代码里并由测试钉住。
 * 这样换数据源改配置，改口径才会动代码。
 */
export const metricInputRuleSchema = z.object({
  /** 工具引用：`<sourceSlug>.<toolName>`，例如 `erp.fetch_revenue`。 */
  tool: z
    .string()
    .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_]*$/, 'tool 需形如 erp.fetch_revenue'),
  /** 结果 `data` 里的数值字段，支持 `a.b` 形式的路径。 */
  field: z.string().min(1),
  /** 字段是数组时，按该子字段求和（SQL 类工具常见的形状）。 */
  sum: z.string().min(1).optional(),
})

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 允许使用哪些 Source（slug 列表）。跨此列表的访问一律 DENY。 */
  sources: z.array(z.string().min(1)),
  /** 允许使用哪些 Skill（name 列表）。 */
  skills: z.array(z.string().min(1)),
  defaultPermissionMode: permissionModeSchema,
  /** 指标规则版本，参与回归比对：规则变了结果就该变。 */
  ruleVersion: z.string().min(1),
  /**
   * 允许的报表接收人名单（分发名单）。
   *
   * 发布前会逐一核对——接收人范围校验是 FR-06.1 的一部分，
   * 因为「发错人」和「发错内容」一样无法撤回。
   */
  allowedRecipients: z.array(z.string().min(1)).default([]),
  /**
   * 审批资格：哪类审批需要哪些角色。
   *
   * 键是审批类别，值是「有资格批准的角色名」。用户的角色来自 `user.approver_roles`。
   * **没有配置 = 没人能批**，而不是谁都能批——缺少策略时系统宁可停住，
   * 也不要把「谁都可以点同意」当成默认值。
   */
  approvalPolicy: z
    .object({
      /** 工具调用审批（当前只有 confidential 级会产生审批）。 */
      confidential: z.array(z.string().min(1)).default([]),
      /** 发布二次确认。 */
      publish: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  /** 职责分离：默认禁止发起人批准自己发起的任务。 */
  segregationOfDuties: z.boolean().default(true),
  /**
   * 指标规则。只配置输入映射；不配置时使用内置默认（ERP/财务/数仓/Excel）。
   *
   * 一旦配置了 `inputs`，就只用配置里的输入——不做逐项回退，
   * 否则少写一行会静默算出另一套数。
   */
  metrics: z
    .object({
      inputs: z.record(z.string(), metricInputRuleSchema).default({}),
      /** 必须具备的指标 key；不配置时用内置默认（收入 / 成本 / 毛利）。 */
      required: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  currency: z.string().length(3),
  timezone: z.string().min(1),
  createdAt: isoTimestamp,
})

export type Workspace = z.infer<typeof workspaceSchema>

/** 磁盘上的 workspace.json 形态（`id`/`createdAt` 由加载器补齐）。 */
export const workspaceFileSchema = workspaceSchema
  .omit({ id: true, createdAt: true })
  .extend({ id: z.string().min(1).optional() })

export type WorkspaceFile = z.infer<typeof workspaceFileSchema>
