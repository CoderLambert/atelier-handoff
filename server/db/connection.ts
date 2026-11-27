/**
 * @file 打开工作台 SQLite 连接并装配 Drizzle 仓储。
 * @implementation 让旧 Store 与全部 Drizzle 仓储共用数据库句柄，以 repos 组合暴露仓储，提供读取事务并按版本顺序登记迁移。
 * @updated 2026-11-27T20:10:00+08:00
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
import { shortcutPreferencesRepository } from './repositories/shortcut-preferences.js';
import { skillInheritanceRepository } from './repositories/skill-inheritance.js';
import { skillToolBindingsRepository } from './repositories/skill-tool-bindings.js';
import { githubPublicAuthRepository } from './repositories/github-public-auth.js';
import { rtkSettingsRepository } from './repositories/rtk-settings.js';

import { applyGitWorktrees } from './migrations/apply-git-worktrees.js';
import { gitWorktreeRepository } from './repositories/git-worktrees.js';
import { messageQueueRepository } from './repositories/message-queue.js';
import { runtimeRecordRepositories } from './repositories/runtime-records.js';
import { applyRuntimeHotpathIndexes } from './migrations/apply-runtime-hotpath-indexes.js';
import { applyGitCommitOperations } from './migrations/apply-git-commit-operations.js';
import { applyGitCommitOperationLifecycle } from './migrations/apply-git-commit-operation-lifecycle.js';
import { gitCommitOperationRepository } from './repositories/git-commit-operations.js';
import { assertForeignKeyIntegrity } from './maintenance/foreign-key-integrity.js';
import { applyScheduledTasks } from './migrations/apply-scheduled-tasks.js';
import { scheduleRepository } from './repositories/schedules.js';

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

export const LATEST_SCHEMA_VERSION = 12;
export type SchemaMigration = { version: number; apply: () => void };

export function openWorkbenchDatabase(path: string) {
  const native = new SQLite(path);
  const db: LegacyDatabase = native;
  const orm = drizzle({ client: native });
  const migrations: readonly SchemaMigration[] = [
    { version: 6, apply: () => applySnapshotIndexes(db) },
    { version: 7, apply: () => applySubagents(db) },
    { version: 8, apply: () => applyGitWorktrees(db) },
    { version: 9, apply: () => applyGitCommitOperations(db) },
    { version: 10, apply: () => applyGitCommitOperationLifecycle(db) },
    { version: 11, apply: () => applyRuntimeHotpathIndexes(db) },
    { version: 12, apply: () => applyScheduledTasks(db) },
  ];
  const repos = {
    sessionSnapshots: sessionSnapshotRepository(orm),
    sessionEvents: sessionEventRepository(orm),
    runReceipts: runReceiptRepository(orm),
    subagents: subagentRepository(orm),
    messageQueue: messageQueueRepository(orm),
    ...runtimeRecordRepositories(orm),
    workspaceLayout: workspaceLayoutRepository(orm),
    gitMultiCommitPreferences: gitMultiCommitPreferencesRepository(orm),
    shortcutPreferences: shortcutPreferencesRepository(orm),
    skillInheritance: skillInheritanceRepository(orm),
    skillToolBindings: skillToolBindingsRepository(orm),
    rtkSettings: rtkSettingsRepository(orm),
    githubPublicAuth: githubPublicAuthRepository(orm),
    gitWorktrees: gitWorktreeRepository(orm),
    gitCommitOperations: gitCommitOperationRepository(orm),
    schedules: scheduleRepository(orm),
  };
  return {
    db,
    readTransaction: <T>(work: () => T): T => native.transaction(work).deferred(),
    assertForeignKeyIntegrity: () => assertForeignKeyIntegrity(db),
    repos,
    migrations,
  };
}

export type WorkbenchRepositories = ReturnType<typeof openWorkbenchDatabase>['repos'];
