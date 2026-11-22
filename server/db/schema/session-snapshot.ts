/**
 * @file 描述会话快照在 SQLite v6 中读取的列。
 * @implementation 映射既有 JSON 记录、派生归属列和事件表，实际 DDL 由版本化迁移负责。
 * @updated 2026-11-21T01:00:00+08:00
 */
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const recordColumns = () => ({ id: text('id').primaryKey(), data: text('data').notNull() });
const scopedColumns = () => ({ ...recordColumns(), sessionId: text('session_id') });

export const projects = sqliteTable('projects', recordColumns());
export const sessions = sqliteTable('sessions', recordColumns());
export const runs = sqliteTable('runs', scopedColumns(), (table) => [
  uniqueIndex('runs_subagent_scope').on(table.id, table.sessionId),
]);
export const messages = sqliteTable('messages', scopedColumns());
export const tools = sqliteTable('tools', scopedColumns());
export const permissions = sqliteTable('permissions', scopedColumns());
export const artifacts = sqliteTable('artifacts', scopedColumns());
export const attachments = sqliteTable('attachments', {
  ...scopedColumns(),
  visible: integer('snapshot_visible'),
});
export const events = sqliteTable('events', {
  id: integer('id').primaryKey(),
  runId: text('run_id').notNull(),
  sessionId: text('session_id').notNull(),
  seq: integer('seq').notNull(),
  type: text('type').notNull(),
  at: text('at').notNull(),
  payload: text('payload').notNull(),
});
