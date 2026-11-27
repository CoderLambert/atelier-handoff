/**
 * @file 使用 Drizzle 读写和清理会话运行事件。
 * @implementation 封装事件游标、顺序追加、增量拉取、会话与运行历史读取以及按会话删除，保持原有事件结构与顺序。
 * @updated 2026-11-27T11:20:00-08:00
 */
import { and, asc, count, desc, eq, gt, ne } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { RunEvent } from '../../../shared/types.js';
import { events } from '../schema/session-snapshot.js';

type EventRow = typeof events.$inferSelect;

function toRunEvent(row: EventRow): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    sessionId: row.sessionId,
    seq: row.seq,
    type: row.type,
    at: row.at,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

export function sessionEventRepository(db: BetterSQLite3Database) {
  return {
    cursor(): number {
      return (
        db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1).get()?.id ?? 0
      );
    },
    append(
      runId: string,
      sessionId: string,
      type: string,
      at: string,
      payload: Record<string, unknown> = {},
    ): RunEvent {
      const lastSeq =
        db
          .select({ seq: events.seq })
          .from(events)
          .where(eq(events.runId, runId))
          .orderBy(desc(events.seq))
          .limit(1)
          .get()?.seq ?? 0;
      const seq = lastSeq + 1;
      const insert = db
        .insert(events)
        .values({ runId, sessionId, seq, type, at, payload: JSON.stringify(payload) })
        .run();
      return {
        id: Number(insert.lastInsertRowid),
        runId,
        sessionId,
        seq,
        type,
        at,
        payload,
      };
    },
    since(cursor: number, limit = 1000): RunEvent[] {
      return db
        .select()
        .from(events)
        .where(gt(events.id, cursor))
        .orderBy(asc(events.id))
        .limit(limit)
        .all()
        .map(toRunEvent);
    },
    history(sessionId: string): RunEvent[] {
      return db
        .select()
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .orderBy(desc(events.id))
        .limit(500)
        .all()
        .reverse()
        .map(toRunEvent);
    },
    runHistory(runId: string): { events: RunEvent[]; eventCount: number } {
      const eventCount =
        db.select({ count: count() }).from(events).where(eq(events.runId, runId)).get()?.count ?? 0;
      const rows = db
        .select()
        .from(events)
        .where(and(eq(events.runId, runId), ne(events.type, 'message.delta')))
        .orderBy(desc(events.seq))
        .limit(600)
        .all()
        .reverse()
        .map(toRunEvent);
      return { events: rows, eventCount };
    },
    deleteForSession(sessionId: string): void {
      db.delete(events).where(eq(events.sessionId, sessionId)).run();
    },
  };
}
