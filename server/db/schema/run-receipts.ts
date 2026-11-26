/**
 * @file 映射运行的既有幂等回执表。
 * @implementation 对应历史 idempotency 表的键、请求摘要和运行标识，不创建或迁移表。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const runReceipts = sqliteTable('idempotency', {
  key: text('key').primaryKey(),
  bodyHash: text('body_hash').notNull(),
  runId: text('run_id').notNull(),
});
