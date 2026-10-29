import { z } from 'zod'
import { completenessSchema, isoTimestamp, jsonObject, reportStatusSchema } from './common.ts'

/** 指标结果：既给数值，也给口径来源，方便人工核对与回归比对。 */
export const metricValueSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** 展示值（已按币种与单位格式化前的原始数值）。 */
  value: z.number(),
  unit: z.string().min(1),
  /** 计算口径说明，写清楚「减了哪些成本、含不含税」这类必须交代的事。 */
  formula: z.string().min(1),
  /** 参与计算的 resultId，回溯到具体取数结果。 */
  inputs: z.array(z.string().min(1)),
  completeness: completenessSchema,
})

export type MetricValue = z.infer<typeof metricValueSchema>

/** 口径冲突：同一指标在不同来源对不上时，不静默取其一，而是显式记录。 */
export const conflictSchema = z.object({
  metricKey: z.string().min(1),
  description: z.string().min(1),
  candidates: z.array(
    z.object({
      sourceSlug: z.string().min(1),
      resultId: z.string().min(1),
      value: z.number(),
    }),
  ),
})

export type Conflict = z.infer<typeof conflictSchema>

/**
 * report（PRD §7 / FR-06）。
 *
 * `draftVersion` 与 `recipientsHash` 是发布二次确认的绑定对象：
 * 接收人一变，原来的确认就作废。
 */
export const reportSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  draftVersion: z.string().min(1),
  status: reportStatusSchema,
  /** 指标规则版本，参与回归比对。 */
  ruleVersion: z.string().min(1),
  metrics: z.array(metricValueSchema),
  conflicts: z.array(conflictSchema),
  /** 参与本次报表的取数结果引用。 */
  resultRefs: z.array(z.string().min(1)),
  /** 数据版本集合：数据变了，报表的结论就该重新审。 */
  dataVersions: z.record(z.string(), z.string()),
  /** 接收人摘要；发布确认绑定它。 */
  recipientsHash: z.string().min(1).nullable().default(null),
  receiptId: z.string().min(1).nullable().default(null),
  artifactPath: z.string().min(1).nullable().default(null),
  meta: jsonObject.default({}),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
})

export type Report = z.infer<typeof reportSchema>

/** 报表产物 JSON 的形态，写盘为 `draft-v{n}.json`。 */
export const reportArtifactSchema = z.object({
  reportId: z.string().min(1),
  sessionId: z.string().min(1),
  draftVersion: z.string().min(1),
  ruleVersion: z.string().min(1),
  period: z.string().min(1),
  currency: z.string().min(1),
  generatedAt: isoTimestamp,
  metrics: z.array(metricValueSchema),
  conflicts: z.array(conflictSchema),
  sources: z.array(
    z.object({
      slug: z.string().min(1),
      resultId: z.string().min(1),
      dataVersion: z.string().min(1),
      completeness: completenessSchema,
    }),
  ),
  warnings: z.array(z.string()),
})

export type ReportArtifact = z.infer<typeof reportArtifactSchema>
