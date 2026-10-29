import { asc, desc, eq } from 'drizzle-orm'
import type { Checkpoint, SessionState } from '@datasentry/core'
import { schema, type Db } from '../db/index.ts'

export interface SaveCheckpointInput {
  sessionId: string
  step: number
  stateVersion: number
  inputVersion: string
  state: SessionState
  outputRef?: string | null
  approvalRef?: string | null
}

function toCheckpoint(row: typeof schema.checkpoints.$inferSelect): Checkpoint {
  return {
    sessionId: row.sessionId,
    step: row.step,
    stateVersion: row.stateVersion,
    inputVersion: row.inputVersion,
    outputRef: row.outputRef ?? null,
    approvalRef: row.approvalRef ?? null,
    state: row.state,
    createdAt: row.createdAt,
  }
}

/**
 * 检查点（PRD FR-04.2）。
 *
 * 每个安全步骤之后落一条，记录 state / step / state_version / input_version /
 * output_ref / approval_ref。M1 只负责**写**；读取与恢复逻辑在 M3 落地，
 * 但写入从第一天就开始，否则 M3 上线时没有任何历史检查点可用。
 *
 * 主键是 `(session_id, step)` 且用 upsert：同一个步骤被重放时更新而不是插入两条，
 * 这样「恢复后重做某一步」不会在轨迹里留下两个互相矛盾的检查点。
 */
export class CheckpointStore {
  constructor(private readonly db: Db) {}

  save(input: SaveCheckpointInput): Checkpoint {
    const now = new Date().toISOString()
    this.db
      .insert(schema.checkpoints)
      .values({
        sessionId: input.sessionId,
        step: input.step,
        stateVersion: input.stateVersion,
        inputVersion: input.inputVersion,
        outputRef: input.outputRef ?? null,
        approvalRef: input.approvalRef ?? null,
        state: input.state,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.checkpoints.sessionId, schema.checkpoints.step],
        set: {
          stateVersion: input.stateVersion,
          inputVersion: input.inputVersion,
          outputRef: input.outputRef ?? null,
          approvalRef: input.approvalRef ?? null,
          state: input.state,
          createdAt: now,
        },
      })
      .run()

    return {
      sessionId: input.sessionId,
      step: input.step,
      stateVersion: input.stateVersion,
      inputVersion: input.inputVersion,
      outputRef: input.outputRef ?? null,
      approvalRef: input.approvalRef ?? null,
      state: input.state,
      createdAt: now,
    }
  }

  /** 最新检查点。M3 的恢复入口。 */
  latest(sessionId: string): Checkpoint | undefined {
    const row = this.db
      .select()
      .from(schema.checkpoints)
      .where(eq(schema.checkpoints.sessionId, sessionId))
      .orderBy(desc(schema.checkpoints.step))
      .limit(1)
      .all()[0]
    return row ? toCheckpoint(row) : undefined
  }

  list(sessionId: string): Checkpoint[] {
    return this.db
      .select()
      .from(schema.checkpoints)
      .where(eq(schema.checkpoints.sessionId, sessionId))
      .orderBy(asc(schema.checkpoints.step))
      .all()
      .map(toCheckpoint)
  }
}
