/**
 * @file 定义工作树归属、会话绑定及可重放的操作回执。
 * @implementation 用关联键及索引保存 Git 目录身份和全生命周期状态。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { projects, sessions } from './session-snapshot.js';

export const gitWorktrees = sqliteTable('git_worktrees', {
  id: text('id').primaryKey().notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  repositoryId: text('repository_id').notNull(),
  mode: text('mode').notNull(),
  branch: text('branch').notNull(),
  directoryIdentity: text('directory_identity'),
  adminIdentity: text('admin_identity'),
  snapshotId: text('snapshot_id'),
  snapshotDigest: text('snapshot_digest'),
  retained: text('retained'),
  rebuildable: text('rebuildable').notNull(),
});

export const gitSessionWorktrees = sqliteTable('git_session_worktrees', {
  sessionId: text('session_id')
    .primaryKey()
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  worktreeId: text('worktree_id')
    .notNull()
    .references(() => gitWorktrees.id),
});

export const gitWorktreeOperations = sqliteTable('git_worktree_operations', {
  id: text('id').primaryKey().notNull(),
  worktreeId: text('worktree_id')
    .notNull()
    .references(() => gitWorktrees.id, { onDelete: 'cascade' }),
  requestHash: text('request_hash').notNull(),
  kind: text('kind').notNull(),
  state: text('state').notNull(),
  sessionId: text('session_id'),
  branch: text('branch').notNull(),
  oid: text('oid').notNull(),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
  scratchIdentity: text('scratch_identity'),
  error: text('error'),
});
