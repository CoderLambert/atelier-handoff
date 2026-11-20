/**
 * @file 打开工作台 SQLite 连接并装配 Drizzle 仓储。
 * @implementation 旧 Store 的参数化语句和快照仓储共享一个 better-sqlite3 句柄及事务生命周期。
 * @updated 2026-11-21T01:00:00+08:00
 */
import SQLite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sessionSnapshotRepository } from './repositories/session-snapshot.js';
import { applySnapshotIndexes } from './migrations/apply-snapshot-indexes.js';

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
  return {
    db,
    readTransaction: <T>(work: () => T): T => native.transaction(work).deferred(),
    sessionSnapshots: sessionSnapshotRepository(drizzle({ client: native })),
    applySnapshotIndexes: () => applySnapshotIndexes(db),
  };
}
