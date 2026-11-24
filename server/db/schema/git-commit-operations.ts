/**
 * @file 定义多提交操作的 SQLite 持久化列。
 * @implementation 保存具名身份、版本和恢复文件引用；固定迁移施加状态约束及未完成操作唯一索引。
 * @updated 2026-11-24T14:57:15+08:00
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { projects } from './session-snapshot.js';

export const gitCommitOperations = sqliteTable('git_commit_operations', {
  operationId: text('operation_id').primaryKey().notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'restrict' }),
  repositoryId: text('repository_id').notNull(),
  worktreeIdentity: text('worktree_identity').notNull(),
  adminIdentity: text('admin_identity').notNull(),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  state: text('state').notNull(),
  revision: integer('revision').notNull(),
  ref: text('ref').notNull(),
  oldHead: text('old_head'),
  newHead: text('new_head').notNull(),
  commits: text('commits').notNull(),
  originalIndexFile: text('original_index_file'),
  originalIndexHash: text('original_index_hash'),
  targetIndexFile: text('target_index_file').notNull(),
  targetIndexHash: text('target_index_hash').notNull(),
  errorCode: text('error_code'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  finishedAt: text('finished_at'),
});
