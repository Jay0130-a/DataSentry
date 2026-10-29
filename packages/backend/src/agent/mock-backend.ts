import { buildToolName, TOOL_NAME_PREFIX, type ToolResult } from '@datasentry/core'
import type { PlanStep, SkillPlan } from '../harness/skill-loader.ts'
import type { AgentAction, AgentBackend, AgentContext, AgentStepRecord } from './backend.ts'
import { buildScope, renderArgs, type TemplateScope } from './planner.ts'

/**
 * 把计划里的工具写法解析成注册表中的全名。
 * - `erp.fetch_revenue`        → `mcp__erp__fetch_revenue`（Source 工具）
 * - `datasentry__read_source_guide` → 原样（内置工具）
 */
export function resolveToolName(reference: string): string {
  if (reference.startsWith(TOOL_NAME_PREFIX) || reference.includes('__')) return reference
  const dot = reference.indexOf('.')
  if (dot <= 0) return reference
  return buildToolName(reference.slice(0, dot), reference.slice(dot + 1))
}

/**
 * 确定性脚本化规划器 —— M1 的默认 Agent 后端。
 *
 * 它按 `plan.yaml` 逐步产出工具调用，参数从输入与前序结果插值而来。
 * 同一输入永远产出同一条轨迹，这是 M4 回归能判定 PASS/FAIL 的前提。
 *
 * 这不是「假装成 LLM」：它的定位是一个可复现的参照实现——
 * 用来验证 Harness（权限链、Schema、状态机、事件轨迹）本身是否正确。
 * 换成真实 LLM 时，被验证的这些边界一行都不用改。
 */
export class MockAgentBackend implements AgentBackend {
  readonly name = 'mock-scripted-planner'

  constructor(private readonly plan: SkillPlan) {}

  get stepCount(): number {
    return this.plan.steps.length
  }

  /** 第 index 步的计划定义，供调用方（回归脚本）读取预期。 */
  stepAt(index: number): PlanStep | undefined {
    return this.plan.steps[index]
  }

  async nextAction(ctx: AgentContext): Promise<AgentAction> {
    // 历史长度即「已尝试的步数」——被拒绝的步骤也算一步，
    // 否则拒绝之后会原地重试同一步，掩盖掉真实的失败。
    const index = ctx.history.length
    const step = this.plan.steps[index]

    if (!step) {
      return {
        type: 'finish',
        summary: `计划中的 ${this.plan.steps.length} 个步骤已全部执行`,
      }
    }

    const scope: TemplateScope = buildScope(
      ctx.input,
      { id: ctx.sessionId, workspaceId: ctx.workspaceId },
      collectResults(this.plan.steps, ctx.history),
    )

    return {
      type: 'tool_calls',
      calls: [{ name: resolveToolName(step.tool), args: renderArgs(step.args, scope) }],
      ...(step.description !== undefined ? { rationale: step.description } : {}),
    }
  }
}

/** 计划步骤 id 与历史按位置对应（脚本规划器按序推进）。 */
function collectResults(
  steps: readonly PlanStep[],
  history: readonly AgentStepRecord[],
): Record<string, ToolResult | undefined> {
  const results: Record<string, ToolResult | undefined> = {}
  steps.forEach((step, index) => {
    results[step.id] = history[index]?.result
  })
  return results
}
