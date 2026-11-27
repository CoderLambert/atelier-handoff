/**
 * @file 描述待处理消息队列的既有 SQLite 表。
 * @implementation 对应 v4/v5 的 pending_messages 列，顺序、优先级、投递状态和授权错误均为具名列，不创建或迁移表。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const pendingMessages = sqliteTable('pending_messages', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull(),
  sessionId: text('session_id').notNull(),
  requestKey: text('request_key').notNull(),
  bodyHash: text('body_hash').notNull(),
  data: text('data').notNull(),
  withdrawn: integer('withdrawn').notNull().default(0),
  paused: integer('paused').notNull().default(0),
  error: text('error'),
  priority: integer('priority').notNull().default(0),
  delivery: text('delivery', { enum: ['waiting', 'sending', 'unknown'] }),
  targetRunId: text('target_run_id'),
});
