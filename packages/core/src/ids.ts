import { randomUUID } from 'node:crypto'

/** 带前缀的实体 ID 前缀，便于日志与事件轨迹中肉眼识别类型。 */
export type IdPrefix =
  | 'ws' // workspace
  | 'sess' // session
  | 'src' // source
  | 'skl' // skill
  | 'tc' // tool_call
  | 'apv' // approval
  | 'ckpt' // checkpoint
  | 'evt' // event
  | 'rpt' // report
  | 'rcpt' // receipt
  | 'res' // tool result
  | 'run' // eval run

/** 生成 `{prefix}_{32位十六进制}` 形式的 ID。 */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

export const newWorkspaceId = (): string => newId('ws')
export const newSessionId = (): string => newId('sess')
export const newSourceId = (): string => newId('src')
export const newToolCallId = (): string => newId('tc')
export const newApprovalId = (): string => newId('apv')
export const newEventId = (): string => newId('evt')
export const newReportId = (): string => newId('rpt')
export const newResultId = (): string => newId('res')
export const newTraceId = (): string => newId('run')
