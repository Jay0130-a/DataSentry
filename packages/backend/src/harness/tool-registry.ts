import type { RegisteredTool } from '../sources/builder.ts'

/** 内置工具：读取 Source 的 guide。读过的 Source 才会解锁其工具调用。 */
export const READ_SOURCE_GUIDE_TOOL = 'datasentry__read_source_guide'

/**
 * 内置工具是 Harness 自己的能力，不属于任何 Source。
 * 它们同样要过参数 Schema 校验，但不受 Workspace 边界与 guide 约束。
 */
export function builtinTools(): RegisteredTool[] {
  return [
    {
      name: READ_SOURCE_GUIDE_TOOL,
      kind: 'builtin',
      sourceSlug: 'datasentry',
      toolName: 'read_source_guide',
      title: '读取数据源使用说明',
      description:
        '读取指定 Source 的 guide.md。调用任何 Source 工具之前必须先读它的 guide，否则会被拒绝。',
      paramsSchema: {
        type: 'object',
        properties: { sourceSlug: { type: 'string', minLength: 1 } },
        required: ['sourceSlug'],
        additionalProperties: false,
      },
      resultSchema: { type: 'object' },
      sensitivity: 'public',
      sideEffect: 'read',
      requiresGuide: false,
      toolVersion: 'builtin:v1',
    },
  ]
}

/**
 * 计算一次调用真正作用在哪个 Source 上。
 *
 * 读 guide 的工具本身不属于任何 Source，但它的**目标**是一个 Source——
 * 权限链据此对目标施加同样的 Workspace 边界与激活状态检查。
 */
export function subjectSourceOf(
  tool: RegisteredTool | undefined,
  args: Record<string, unknown>,
): string | null {
  if (!tool) return null
  if (tool.kind === 'source') return tool.sourceSlug
  if (tool.name === READ_SOURCE_GUIDE_TOOL) {
    const target = args['sourceSlug']
    return typeof target === 'string' && target.length > 0 ? target : null
  }
  return null
}

/**
 * 工具注册表。
 *
 * 这是 PreToolUse 第一道检查的依据：不在表里的工具名一律 `TOOL_NOT_REGISTERED`，
 * 不存在「模型想调什么就调什么」的余地。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  static from(tools: readonly RegisteredTool[]): ToolRegistry {
    const registry = new ToolRegistry()
    registry.addAll(tools)
    return registry
  }

  add(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具名重复注册：${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  addAll(tools: readonly RegisteredTool[]): void {
    for (const tool of tools) this.add(tool)
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  bySource(slug: string): RegisteredTool[] {
    return this.list().filter((tool) => tool.kind === 'source' && tool.sourceSlug === slug)
  }

  get size(): number {
    return this.tools.size
  }
}
