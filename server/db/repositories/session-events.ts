/**
 * @file 清理被删除会话的已保存事件。
 * @implementation 把会话约束交给同连接的 Drizzle 查询，由删除用例决定提交顺序。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { events } from '../schema/session-snapshot.js';

export function sessionEventRepository(db: BetterSQLite3Database) {
  return {
    deleteForSession(sessionId: string): void {
      db.delete(events).where(eq(events.sessionId, sessionId)).run();
    },
  };
}
