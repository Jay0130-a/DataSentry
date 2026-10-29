import type { ToolExecution } from '@datasentry/core'

/**
 * 传输层的统一接口（PRD FR-01.2）。
 *
 * mcp-stdio / http / local 三种接入方式的差异全部收敛在各自实现里，
 * 上层（Agent Loop、PreToolUse）只认这一个方法。加一种接入方式不需要改上层。
 */
export interface SourceTransport {
  readonly slug: string
  call(toolName: string, args: Record<string, unknown>): Promise<ToolExecution>
  close(): Promise<void>
}

/** Source 侧返回的错误。`code` 来自 Source 或传输层，用于事件轨迹与断言。 */
export class ToolExecutionError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ToolExecutionError'
    this.code = code
    this.details = details
  }
}

/** 把 `{content:[{type:'text',text}]}` 之类的载荷解成 ToolExecution。 */
export function parseExecutionPayload(raw: unknown): ToolExecution {
  const value =
    typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw

  if (value === null || typeof value !== 'object') {
    throw new ToolExecutionError(
      'TOOL_RESULT_SCHEMA_INVALID',
      `Source 返回的不是对象：${JSON.stringify(value).slice(0, 120)}`,
    )
  }

  const record = value as Record<string, unknown>
  if (record['error'] !== undefined) {
    const err = record['error'] as { code?: string; message?: string }
    throw new ToolExecutionError(
      err.code ?? 'TOOL_EXECUTION_FAILED',
      err.message ?? 'Source 返回了未说明的错误',
    )
  }

  const meta = record['meta']
  if (meta === null || typeof meta !== 'object') {
    throw new ToolExecutionError(
      'TOOL_RESULT_SCHEMA_INVALID',
      'Source 返回值缺少 meta（dataVersion / completeness / rowCount）',
    )
  }

  const metaRecord = meta as Record<string, unknown>
  return {
    data: record['data'],
    meta: {
      ...metaRecord,
      dataVersion: String(metaRecord['dataVersion'] ?? 'unknown'),
      completeness: (metaRecord['completeness'] ?? 'unknown') as ToolExecution['meta']['completeness'],
      rowCount: Number(metaRecord['rowCount'] ?? 0),
    },
  }
}
