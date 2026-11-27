/**
 * @file 使用 Drizzle 保存并终结会话子任务。
 * @implementation 通过唯一标识、运行归属与状态谓词实现幂等写入，恢复时一次终结遗留运行中任务。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { and, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { subagentSchema, type Subagent } from '../../../shared/subagents.js';
import { AppError } from '../../../shared/errors.js';
import type { SubagentRepository } from '../../modules/sessions/subagent-repository.js';
import { subagents } from '../schema/subagents.js';

export function decodeSubagent(value: unknown): Subagent {
  const parsed = subagentSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_STORED_RECORD', '子任务记录格式异常。', 500);
  return parsed.data;
}

export function subagentRepository(db: BetterSQLite3Database): SubagentRepository {
  return {
    start(value) {
      const inserted = db
        .insert(subagents)
        .values(value)
        .onConflictDoNothing({ target: subagents.id })
        .run();
      if (inserted.changes === 1) return true;
      const existing = db.select().from(subagents).where(eq(subagents.id, value.id)).get();
      if (
        !existing ||
        existing.runId !== value.runId ||
        existing.sessionId !== value.sessionId ||
        existing.kind !== value.kind ||
        existing.title !== value.title ||
        existing.startedAt !== value.startedAt
      )
        throw new AppError('SUBAGENT_CONFLICT', '子任务标识已用于其他任务。', 409);
      return false;
    },
    finish(id, runId, status, summary, endedAt) {
      const row = db
        .update(subagents)
        .set({ status, summary, endedAt })
        .where(
          and(eq(subagents.id, id), eq(subagents.runId, runId), eq(subagents.status, 'running')),
        )
        .returning()
        .get();
      return row ? decodeSubagent(row) : undefined;
    },
    interruptRunning(endedAt) {
      return db
        .update(subagents)
        .set({ status: 'interrupted', endedAt })
        .where(eq(subagents.status, 'running'))
        .returning()
        .all()
        .map(decodeSubagent);
    },
  };
}
