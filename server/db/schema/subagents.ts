/**
 * @file 定义 SQLite 子任务记录和归属索引。
 * @implementation 以具名列保存共享任务字段，通过会话与运行外键约束归属并在父记录删除时级联清理。
 * @updated 2026-11-21T12:00:00+00:00
 */
import { foreignKey, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { runs, sessions } from './session-snapshot.js';

export const subagents = sqliteTable(
  'subagents',
  {
    id: text('id').primaryKey().notNull(),
    runId: text('run_id').notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['explore', 'worker'] }).notNull(),
    title: text('title').notNull(),
    status: text('status', {
      enum: ['running', 'completed', 'failed', 'stopped', 'interrupted'],
    }).notNull(),
    summary: text('summary'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => [
    foreignKey({
      columns: [table.runId, table.sessionId],
      foreignColumns: [runs.id, runs.sessionId],
    }).onDelete('cascade'),
    index('subagents_session').on(table.sessionId, table.startedAt, table.id),
    index('subagents_run').on(table.runId, table.status),
  ],
);
