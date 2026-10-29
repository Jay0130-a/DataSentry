import type { ToolResult } from '@datasentry/core'
import type { AgentContext, AgentStepRecord } from './backend.ts'

/**
 * 提示词构造。
 *
 * 抽成独立模块，是因为**换模型不该改变喂给它的信息**。
 * Claude 与 OpenAI-compatible 两个后端共用同一份系统提示与任务描述，
 * 这样两边行为上的差异可以归因到模型本身，而不是「提示词写法不同」。
 */

/**
 * 系统提示词。
 *
 * 刻意把「哪些事绝对不能做」写清楚——但这些只是**软约束**：
 * 真正的硬边界在 PreToolUse 里，模型说了不算。
 * 提示词的作用是减少无效尝试，不是提供安全保障。
 */
export function buildSystemPrompt(ctx: AgentContext): string {
  const lines: string[] = []

  lines.push('你是 DataSentry 的企业报表 Agent。你的任务是在受控工具范围内完成一份报表。')
  lines.push('')
  lines.push(`## 当前 Skill：${ctx.skill.name}`)
  lines.push(ctx.skill.body.trim())
  lines.push('')

  lines.push('## 可用工具')
  for (const tool of ctx.tools) {
    lines.push(
      `- \`${tool.name}\`：${tool.description}` +
        (tool.name.startsWith('mcp__')
          ? `（该 Source 的 guide 已读：${tool.guideRead ? '是' : '否'}）`
          : ''),
    )
  }
  lines.push('')

  lines.push('## 规则')
  lines.push('1. 调用某个 Source 的工具前，必须先用 `datasentry__read_source_guide` 读它的 guide。')
  lines.push(`2. 只能使用这些 Source：${ctx.activeSourceSlugs.join('、') || '（无）'}。`)
  lines.push('3. 不要用相同参数重复调用同一个工具；失败后不要原样重试。')
  lines.push('4. 被权限链拒绝时立即停止，不要换参数绕过。')
  lines.push('5. 数据取齐后直接回复一句话总结，不要再调用工具。')
  lines.push('')

  lines.push('## 进度')
  lines.push(`已完成 ${ctx.history.length} 步。`)

  return lines.join('\n')
}

export function buildTaskPrompt(ctx: AgentContext): string {
  return [
    `需求：${ctx.request}`,
    '',
    `结构化输入：${JSON.stringify(ctx.input)}`,
    '',
    '请开始。需要取数就调用工具；数据齐了就用一句话总结并结束。',
  ].join('\n')
}

/**
 * 给模型看的结果。
 *
 * 直接塞 `data` 而不要整个信封（resultId / sourceRef 那些是给审计用的），
 * 但保留 meta 里的数据版本与完整性——模型需要知道口径是否完整。
 */
export function summarizeResult(result: ToolResult): Record<string, unknown> {
  return {
    data: result.data,
    completeness: result.completeness,
    dataVersion: result.sourceRef.dataVersion,
    rowCount: result.meta.rowCount,
  }
}

/** 读 guide 这一步回给模型的文本。 */
export function formatGuideNote(sourceSlug: string, guideText: string): string {
  return `已读取 ${sourceSlug} 的 guide（${guideText.length} 字节）：\n\n${guideText}`
}

/** 工具结果的文本形态，两个后端的工具回填都用它。 */
export function renderToolResult(step: AgentStepRecord): string {
  if (step.status === 'succeeded') {
    if (step.result) return JSON.stringify(summarizeResult(step.result))
    // 内置工具（读 guide 等）不产出取数结果，但有返回文本。
    // 早先这里漏了分支，成功会被渲染成「调用未成功：UNKNOWN」——
    // 模型据此判定全线失败并放弃任务。
    if (step.note) return step.note
    return '调用成功（无返回内容）'
  }
  return `调用未成功：${step.errorCode ?? 'UNKNOWN'} ${step.errorMessage ?? ''}`.trim()
}

/**
 * 历史里每一步对应的稳定工具调用 ID。
 *
 * 各家对 ID 的形态要求不同（Anthropic 习惯 `toolu_`，OpenAI 系习惯 `call_`），
 * 所以前缀由调用方给。只要在**一次请求内**稳定且成对，协议就不关心具体格式。
 */
export function toolCallIdFor(prefix: string, index: number, toolName: string): string {
  return `${prefix}${index}_${toolName.replaceAll('__', '_')}`
}
