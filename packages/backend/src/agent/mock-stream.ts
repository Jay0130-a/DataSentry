import type { ToolResult } from '@datasentry/core'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { buildScope, renderArgs } from './planner.ts'
import { resolveToolName } from './mock-backend.ts'
import type { SkillPlan } from '../harness/skill-loader.ts'

/**
 * 确定性的 `streamFn` —— 把 `plan.yaml` 变成 pi 循环的「模型」。
 *
 * 这是 plan.yaml 在迁移后的新形态：不再是一个独立的 `AgentBackend`，
 * 而是 pi `Agent` 的一个脚本化模型。于是**回归样本和生产走的是同一条循环**，
 * 区别只在「谁来产生下一步」。
 */
export interface MockScript {
  plan: SkillPlan
  input: Record<string, unknown>
  sessionId: string
  /** 已执行步骤的结果，按 plan step id 记录。 */
  results: Record<string, ToolResult | undefined>
  /** 当前步骤下标。由工具执行推进。 */
  index: number
}

export function createMockScript(plan: SkillPlan, input: Record<string, unknown>, sessionId: string): MockScript {
  return { plan, input, sessionId, results: {}, index: 0 }
}

export interface MockStream {
  streamFn: StreamFn
  /** 脚本模型对象，作为 `Agent.initialState.model`。 */
  model: unknown
  /** 工具执行完后调用：记录结果并推进到下一步。 */
  advance(stepId: string, result: ToolResult | undefined): void
  /** 当前应当执行的步骤 id（供工具层记录结果用）。 */
  currentStepId(): string | undefined
}

export function createMockStream(script: MockScript): MockStream {
  const faux = createFauxCore({ models: [{ id: 'scripted' }] })

  const responses = script.plan.steps.map(
    () =>
      (): ReturnType<typeof fauxAssistantMessage> => {
        const step = script.plan.steps[script.index]
        if (!step) return fauxAssistantMessage('计划中的步骤已全部完成。')

        const scope = buildScope(script.input, { id: script.sessionId }, script.results)
        const args = renderArgs(step.args, scope)
        return fauxAssistantMessage(fauxToolCall(resolveToolName(step.tool), args as never))
      },
  )
  // 最后一条：计划跑完后模型说「完成」，让循环自然结束。
  responses.push(() => fauxAssistantMessage('计划中的步骤已全部完成。'))

  faux.setResponses(responses)

  return {
    streamFn: faux.streamSimple as unknown as StreamFn,
    model: faux.getModel(),
    advance(stepId, result) {
      script.results[stepId] = result
      script.index += 1
    },
    currentStepId() {
      return script.plan.steps[script.index]?.id
    },
  }
}
