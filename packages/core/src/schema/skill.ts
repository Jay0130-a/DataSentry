import { z } from 'zod'
import { isoTimestamp } from './common.ts'

/**
 * SKILL.md（PRD FR-02）。
 *
 * frontmatter 声明 `name` / `description` / `requiredSources`；
 * `requiredSources` 写 **Source slug**，不写具体工具名——工具名是实现细节，
 * Skill 只声明「我需要 ERP、财务、发布这三个能力」，具体调哪个工具由计划和权限层决定。
 */
export const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  requiredSources: z.array(z.string().min(1)).min(1),
  /** 可选：本 Skill 产出的报表类型标识。 */
  reportType: z.string().min(1).optional(),
})

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>

export const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  requiredSources: z.array(z.string().min(1)),
  /** SKILL.md 全文摘要；Session 固定此版本，Skill 改动后可对比回归。 */
  version: z.string().min(1),
  /** 从 body 解析出的停止条件（供事件与提示词使用）。 */
  stopRules: z.array(z.string()),
  /** body 原文，注入 Agent 上下文。 */
  body: z.string(),
  createdAt: isoTimestamp,
})

export type Skill = z.infer<typeof skillSchema>

/** 解析后的完整 Skill 定义，含磁盘路径。 */
export interface LoadedSkill extends Skill {
  /** `skills/<dir>/SKILL.md` 的绝对路径 */
  path: string
  /** 同目录下的确定性计划文件（Mock 模型用），不存在则为 null。 */
  planPath: string | null
}
