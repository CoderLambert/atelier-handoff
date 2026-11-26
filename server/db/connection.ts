/**
 * @file 打开工作台 SQLite 连接并装配 Drizzle 仓储。
 * @implementation 让旧 Store、会话快照、运行回执和 Git 仓储共用数据库句柄，提供读取事务并装配版本迁移入口。
 * @updated 2026-11-24T16:14:33+08:00
 */
import SQLite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sessionSnapshotRepository } from './repositories/session-snapshot.js';
import { sessionEventRepository } from './repositories/session-events.js';
import { runReceiptRepository } from './repositories/run-receipts.js';
import { applySnapshotIndexes } from './migrations/apply-snapshot-indexes.js';
import { applySubagents } from './migrations/apply-subagents.js';
import { subagentRepository } from './repositories/subagents.js';
import { workspaceLayoutRepository } from './repositories/workspace-layout.js';
import { gitMultiCommitPreferencesRepository } from './repositories/git-multi-commit-preferences.js';
import { skillInheritanceRepository } from './repositories/skill-inheritance.js';
import { githubPublicAuthRepository } from './repositories/github-public-auth.js';
import { rtkSettingsRepository } from './repositories/rtk-settings.js';

import { applyGitWorktrees } from './migrations/apply-git-worktrees.js';
import { gitWorktreeRepository } from './repositories/git-worktrees.js';
import { applyGitCommitOperations } from './migrations/apply-git-commit-operations.js';
import { applyGitCommitOperationLifecycle } from './migrations/apply-git-commit-operation-lifecycle.js';
import { gitCommitOperationRepository } from './repositories/git-commit-operations.js';
import { assertForeignKeyIntegrity } from './maintenance/foreign-key-integrity.js';

// The transitional Store only uses scalar bindings and ordinary row-object statements.
type Scalar = string | number | bigint | Uint8Array | null;
export interface LegacyDatabase {
  prepare(source: string): {
    get(...bindings: Scalar[]): Record<string, Scalar> | undefined;
    all(...bindings: Scalar[]): Record<string, Scalar>[];
    run(...bindings: Scalar[]): { changes: number; lastInsertRowid: number | bigint };
  };
  exec(source: string): unknown;
  close(): void;
}

export function openWorkbenchDatabase(path: string) {
  const native = new SQLite(path);
  const db: LegacyDatabase = native;
  const orm = drizzle({ client: native });
  return {
    db,
    readTransaction: <T>(work: () => T): T => native.transaction(work).deferred(),
    assertForeignKeyIntegrity: () => assertForeignKeyIntegrity(db),
    sessionSnapshots: sessionSnapshotRepository(orm),
    sessionEvents: sessionEventRepository(orm),
    runReceipts: runReceiptRepository(orm),
    subagents: subagentRepository(orm),
    workspaceLayout: workspaceLayoutRepository(orm),
    gitMultiCommitPreferences: gitMultiCommitPreferencesRepository(orm),
    skillInheritance: skillInheritanceRepository(orm),
    rtkSettings: rtkSettingsRepository(orm),
    githubPublicAuth: githubPublicAuthRepository(orm),
    applySnapshotIndexes: () => applySnapshotIndexes(db),
    applySubagents: () => applySubagents(db),
    gitWorktrees: gitWorktreeRepository(orm),
    applyGitWorktrees: () => applyGitWorktrees(db),
    gitCommitOperations: gitCommitOperationRepository(orm),
    applyGitCommitOperations: () => applyGitCommitOperations(db),
    applyGitCommitOperationLifecycle: () => applyGitCommitOperationLifecycle(db),
  };
}
