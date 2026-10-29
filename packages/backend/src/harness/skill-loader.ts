import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import {
  dataPaths,
  hashValue,
  skillFrontmatterSchema,
  type DataPaths,
  type LoadedSkill,
} from '@datasentry/core'

const FRONTMATTER_DELIMITER = '---'

export interface ParsedSkillFile {
  frontmatter: Record<string, unknown>
  body: string
}

/** 拆出 `---` 包裹的 frontmatter 与正文。 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const normalized = text.replaceAll('\r\n', '\n')
  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    throw new Error('SKILL.md 必须以 frontmatter（--- 开头）起始')
  }

  const end = normalized.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, FRONTMATTER_DELIMITER.length)
  if (end === -1) {
    throw new Error('SKILL.md 的 frontmatter 没有闭合的 --- 分隔线')
  }

  const rawFrontmatter = normalized.slice(FRONTMATTER_DELIMITER.length + 1, end)
  const body = normalized.slice(end + FRONTMATTER_DELIMITER.length + 2)

  const parsed = YAML.parse(rawFrontmatter) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SKILL.md 的 frontmatter 必须是一个映射')
  }

  return { frontmatter: parsed as Record<string, unknown>, body }
}

/** 从正文里抽出 `## <标题>` 下的项目符号，作为停止条件/禁止事项。 */
export function extractListSection(body: string, heading: string): string[] {
  const lines = body.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (start === -1) return []

  const items: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.startsWith('## ')) break
    const match = /^\s*(?:\d+\.|[-*])\s+(.*)$/.exec(line)
    if (match?.[1]) items.push(match[1].trim())
  }
  return items
}

export interface PlanStep {
  id: string
  /** `erp.fetch_revenue` 或内置工具全名 `datasentry__read_source_guide`。 */
  tool: string
  args: Record<string, unknown>
  description?: string
  /** 该步骤预期被阻断时的错误码；用于负向样本，正常计划不写。 */
  expectDenied?: string
}

export interface SkillPlan {
  steps: PlanStep[]
}

/** skill 目录名 → `skills/<dir>` 的解析，允许按 name 或目录名查找。 */
function resolveSkillDir(name: string, paths: DataPaths): string {
  const direct = join(paths.skills, name)
  if (existsSync(join(direct, 'SKILL.md'))) return direct

  // 也允许传 Skill 的 name（frontmatter 里的值）而不是目录名
  if (!existsSync(paths.skills)) {
    throw new Error(`skills 目录不存在：${paths.skills}`)
  }
  for (const entry of readdirSync(paths.skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(paths.skills, entry.name, 'SKILL.md')
    if (!existsSync(candidate)) continue
    const { frontmatter } = parseSkillFile(readFileSync(candidate, 'utf8'))
    if (frontmatter['name'] === name) return join(paths.skills, entry.name)
  }
  throw new Error(`找不到 Skill "${name}"（在 ${paths.skills} 下）`)
}

/**
 * 加载 SKILL.md（PRD FR-02）。
 *
 * `version` 取文件内容摘要并固定在 Session 上：Skill 改了以后，
 * 进行中的任务仍然按旧版本跑完，回归报告才说得清「是哪一版 Skill 的结果」。
 */
export function loadSkill(name: string, paths: DataPaths = dataPaths()): LoadedSkill {
  const dir = resolveSkillDir(name, paths)
  const path = join(dir, 'SKILL.md')
  const text = readFileSync(path, 'utf8')
  const { frontmatter, body } = parseSkillFile(text)

  const result = skillFrontmatterSchema.safeParse(frontmatter)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `${path} 的 frontmatter 不合法：${first ? `${first.path.join('.')} — ${first.message}` : '未知错误'}`,
    )
  }

  const planPath = join(dir, 'plan.yaml')
  const stopRules = [
    ...extractListSection(body, '停止条件'),
    ...extractListSection(body, '禁止事项').map((item) => `禁止：${item}`),
  ]

  return {
    id: `skl_${hashValue({ path, version: hashValue(text) }).slice(0, 16)}`,
    name: result.data.name,
    description: result.data.description,
    requiredSources: result.data.requiredSources,
    version: hashValue(text).slice(0, 16),
    stopRules,
    body,
    createdAt: new Date().toISOString(),
    path,
    planPath: existsSync(planPath) ? planPath : null,
  }
}

/** 加载 `skills/` 下的全部 Skill，按名称排序。回归报告用它记录版本指纹。 */
export function listSkills(paths: DataPaths = dataPaths()): LoadedSkill[] {
  if (!existsSync(paths.skills)) return []
  return readdirSync(paths.skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(paths.skills, entry.name, 'SKILL.md')))
    .map((entry) => loadSkill(entry.name, paths))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 加载确定性计划（Mock 模型用）。没有 plan.yaml 时返回空计划。 */
export function loadSkillPlan(skill: LoadedSkill): SkillPlan {
  if (!skill.planPath) return { steps: [] }
  const parsed = YAML.parse(readFileSync(skill.planPath, 'utf8')) as unknown
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${skill.planPath} 必须是一个映射`)
  }
  const steps = (parsed as { steps?: unknown }).steps
  if (!Array.isArray(steps)) {
    throw new Error(`${skill.planPath} 缺少 steps 数组`)
  }

  return {
    steps: steps.map((raw, index) => {
      const step = raw as Record<string, unknown>
      const id = String(step['id'] ?? `step-${index + 1}`)
      const tool = String(step['tool'] ?? '')
      if (!tool) throw new Error(`${skill.planPath} 的第 ${index + 1} 步缺少 tool`)
      return {
        id,
        tool,
        args: (step['args'] as Record<string, unknown> | undefined) ?? {},
        ...(step['description'] !== undefined
          ? { description: String(step['description']) }
          : {}),
        ...(step['expectDenied'] !== undefined
          ? { expectDenied: String(step['expectDenied']) }
          : {}),
      }
    }),
  }
}
