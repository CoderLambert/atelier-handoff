/**
 * @file 只读核验工作台 SQLite 的全部声明外键。
 * @implementation 在共享连接执行固定 foreign_key_check 运维语句，发现孤儿即拒绝，不读取业务载荷或修复数据。
 * @updated 2026-11-24T15:51:30+08:00
 */
import type { LegacyDatabase } from '../connection.js';

export class DatabaseForeignKeyIntegrityError extends Error {
  readonly code = 'DATABASE_FOREIGN_KEY_VIOLATION';
  constructor() {
    super('DATABASE_FOREIGN_KEY_VIOLATION');
    this.name = 'DatabaseForeignKeyIntegrityError';
  }
}

/** Drizzle has no schema-wide integrity assertion; this constant, read-only maintenance PRAGMA
 * checks every declared relation, including orphan rows invisible to project-scoped repositories.
 * The caller may bind this check and subsequent reads to one readTransaction snapshot.
 */
export function assertForeignKeyIntegrity(db: Pick<LegacyDatabase, 'prepare'>): void {
  if (db.prepare('PRAGMA foreign_key_check').get() !== undefined)
    throw new DatabaseForeignKeyIntegrityError();
}
