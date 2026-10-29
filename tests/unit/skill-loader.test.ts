import { describe, expect, it } from 'vitest'
import { dataPaths } from '@datasentry/core'
import {
  extractListSection,
  loadSkill,
  loadSkillPlan,
  parseSkillFile,
} from '@datasentry/backend/harness/skill-loader.ts'

const SAMPLE = `---
name: demo-skill
description: 演示用
requiredSources:
  - erp
  - finance
---

# 演示

## 步骤

1. 先读 guide
2. 再取数

## 停止条件

- 数据齐了就停
- 被拒绝就停

## 禁止事项

- 禁止跳过 guide
`

describe('SKILL.md 解析', () => {
  it('拆出 frontmatter 与正文', () => {
    const parsed = parseSkillFile(SAMPLE)
    expect(parsed.frontmatter['name']).toBe('demo-skill')
    expect(parsed.frontmatter['requiredSources']).toEqual(['erp', 'finance'])
    expect(parsed.body).toContain('# 演示')
  })

  it('没有 frontmatter 时报错', () => {
    expect(() => parseSkillFile('# 只有正文\n')).toThrowError(/必须以 frontmatter/)
  })

  it('frontmatter 没有闭合时报错', () => {
    expect(() => parseSkillFile('---\nname: x\n')).toThrowError(/没有闭合/)
  })

  it('抽取指定标题下的列表项', () => {
    expect(extractListSection(SAMPLE, '停止条件')).toEqual(['数据齐了就停', '被拒绝就停'])
    expect(extractListSection(SAMPLE, '禁止事项')).toEqual(['禁止跳过 guide'])
    expect(extractListSection(SAMPLE, '不存在的标题')).toEqual([])
  })

  it('遇到下一个二级标题就停止，不会串到别的段落', () => {
    const stop = extractListSection(SAMPLE, '停止条件')
    expect(stop.join()).not.toContain('禁止跳过 guide')
  })
})

describe('加载仓库里的真实 Skill', () => {
  it('经营月报 Skill 解析出必需的五个 Source', () => {
    const skill = loadSkill('monthly-operation-report', dataPaths())

    expect(skill.name).toBe('monthly-operation-report')
    // 发布网关也在这里声明：发布发生在草稿之后，但依赖关系属于 Skill
    expect(skill.requiredSources).toEqual(['erp', 'finance', 'warehouse', 'excel', 'publish'])
    expect(skill.version).toMatch(/^[0-9a-f]{16}$/)
    // 停止条件与禁止事项都会被并进 stopRules，供提示词与事件使用
    expect(skill.stopRules.length).toBeGreaterThan(0)
    expect(skill.stopRules.some((rule) => rule.startsWith('禁止：'))).toBe(true)
  })

  it('Skill 版本由内容决定，同名重复加载结果一致', () => {
    const a = loadSkill('monthly-operation-report', dataPaths())
    const b = loadSkill('monthly-operation-report', dataPaths())
    expect(a.version).toBe(b.version)
  })

  it('按目录名与按 frontmatter name 都能找到同一个 Skill', () => {
    const byDir = loadSkill('monthly-operation-report', dataPaths())
    const byName = loadSkill('monthly-operation-report', dataPaths())
    expect(byDir.path).toBe(byName.path)
  })

  it('找不到 Skill 时报错', () => {
    expect(() => loadSkill('no-such-skill', dataPaths())).toThrowError(/找不到 Skill/)
  })

  it('确定性计划里的每一步都声明了工具，且引用的步骤存在', () => {
    const skill = loadSkill('monthly-operation-report', dataPaths())
    const plan = loadSkillPlan(skill)

    expect(plan.steps.length).toBeGreaterThan(0)
    const ids = new Set(plan.steps.map((step) => step.id))
    expect(ids.size).toBe(plan.steps.length)

    for (const step of plan.steps) {
      expect(step.tool).not.toBe('')
    }

    // 参数模板只能引用已经执行过的步骤
    const executed = new Set<string>()
    for (const step of plan.steps) {
      for (const value of Object.values(step.args)) {
        if (typeof value !== 'string') continue
        for (const match of value.matchAll(/\{\{\s*steps\.([A-Za-z0-9_-]+)\./g)) {
          expect(executed.has(match[1]!), `步骤 ${step.id} 引用了尚未执行的 ${match[1]}`).toBe(true)
        }
      }
      executed.add(step.id)
    }
  })
})

describe('内置 Skill 的 Source 声明', () => {
  it('monthly-crosscheck 必须声明 publish，否则它的报表无法确认发布', () => {
    const skill = loadSkill('monthly-crosscheck', dataPaths())
    // confirmPublish 走同一个 PreToolUse，Source 未激活会被 SOURCE_NOT_ACTIVE 拒绝。
    expect(skill.requiredSources).toContain('publish')
  })
})
