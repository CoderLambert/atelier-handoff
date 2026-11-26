/**
 * @file 读写运行创建的持久幂等回执。
 * @implementation 使用与运行记录共享的 SQLite 写连接，在调用方事务内读写，并在删除会话时按原键前缀清理。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { eq, like } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { runReceipts } from '../schema/run-receipts.js';

export function runReceiptRepository(db: BetterSQLite3Database) {
  return {
    find(key: string) {
      return db
        .select({ bodyHash: runReceipts.bodyHash, runId: runReceipts.runId })
        .from(runReceipts)
        .where(eq(runReceipts.key, key))
        .get();
    },
    insert(key: string, bodyHash: string, runId: string): void {
      db.insert(runReceipts).values({ key, bodyHash, runId }).run();
    },
    deleteForSession(sessionId: string): void {
      db.delete(runReceipts)
        .where(like(runReceipts.key, sessionId + ':%'))
        .run();
    },
  };
}
