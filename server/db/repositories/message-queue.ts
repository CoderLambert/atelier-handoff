/**
 * @file 使用 Drizzle 读写会话待处理消息。
 * @implementation 以具名操作表达入队、队首领取、优先、实时插入投递、撤回和恢复，所有状态转换带归属谓词并返回受影响行数。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { pendingMessages as table } from '../schema/message-queue.js';

export type PendingMessageRow = typeof table.$inferSelect;
export type NewPendingMessage = {
  id: string;
  sessionId: string;
  requestKey: string;
  bodyHash: string;
  data: string;
};

const interruptedInsertion = '运行中断，插入结果待确认。';
const missingReceipt = '未收到 SDK 回执，请核对会话结果。';

export function messageQueueRepository(db: BetterSQLite3Database) {
  const queueOrder = [desc(table.priority), asc(table.seq)] as const;
  const head = (sessionId: string) =>
    db
      .select({ seq: table.seq })
      .from(table)
      .where(and(eq(table.sessionId, sessionId), eq(table.withdrawn, 0), isNull(table.delivery)))
      .orderBy(...queueOrder)
      .limit(1)
      .get();
  return {
    recoverInterrupted(): void {
      db.update(table).set({ paused: 1 }).where(eq(table.withdrawn, 0)).run();
      db.update(table)
        .set({ delivery: 'unknown', error: interruptedInsertion })
        .where(eq(table.delivery, 'sending'))
        .run();
      db.update(table)
        .set({ delivery: null, targetRunId: null })
        .where(eq(table.delivery, 'waiting'))
        .run();
    },
    findByRequestKey(key: string): PendingMessageRow | undefined {
      return db.select().from(table).where(eq(table.requestKey, key)).get();
    },
    enqueue(entry: NewPendingMessage): void {
      const paused = db
        .select({ seq: table.seq })
        .from(table)
        .where(
          and(
            eq(table.sessionId, entry.sessionId),
            eq(table.withdrawn, 0),
            isNull(table.delivery),
            eq(table.paused, 1),
          ),
        )
        .limit(1)
        .get();
      db.insert(table)
        .values({ ...entry, paused: paused ? 1 : 0 })
        .run();
    },
    hasPending(sessionId: string): boolean {
      return Boolean(
        db
          .select({ seq: table.seq })
          .from(table)
          .where(and(eq(table.sessionId, sessionId), eq(table.withdrawn, 0)))
          .limit(1)
          .get(),
      );
    },
    listBySession(sessionId: string): PendingMessageRow[] {
      return db
        .select()
        .from(table)
        .where(and(eq(table.sessionId, sessionId), eq(table.withdrawn, 0)))
        .orderBy(...queueOrder)
        .all();
    },
    findPending(sessionId: string, id: string): PendingMessageRow | undefined {
      return db
        .select()
        .from(table)
        .where(and(eq(table.sessionId, sessionId), eq(table.id, id), eq(table.withdrawn, 0)))
        .get();
    },
    /** First undelivered item of every session, kept only when it is neither paused nor blocked. */
    listHeads(): PendingMessageRow[] {
      const firsts = new Map<string, PendingMessageRow>();
      for (const row of db
        .select()
        .from(table)
        .where(and(eq(table.withdrawn, 0), isNull(table.delivery)))
        .orderBy(...queueOrder)
        .all())
        if (!firsts.has(row.sessionId)) firsts.set(row.sessionId, row);
      return [...firsts.values()]
        .filter((row) => row.paused === 0 && row.error === null)
        .sort((a, b) => a.seq - b.seq);
    },
    consumeHead(seq: number, sessionId: string): number {
      if (head(sessionId)?.seq !== seq) return 0;
      return db
        .delete(table)
        .where(
          and(
            eq(table.seq, seq),
            eq(table.sessionId, sessionId),
            eq(table.withdrawn, 0),
            isNull(table.delivery),
            eq(table.paused, 0),
            isNull(table.error),
          ),
        )
        .run().changes;
    },
    prioritize(seq: number, sessionId: string): number {
      const top = db
        .select({ priority: table.priority })
        .from(table)
        .where(eq(table.sessionId, sessionId))
        .orderBy(desc(table.priority))
        .limit(1)
        .get();
      return db
        .update(table)
        .set({ priority: Math.max(top?.priority ?? 0, 0) + 1, paused: 0, error: null })
        .where(and(eq(table.seq, seq), eq(table.withdrawn, 0), isNull(table.delivery)))
        .run().changes;
    },
    beginLive(seq: number, runId: string): number {
      return db
        .update(table)
        .set({ delivery: 'waiting', targetRunId: runId, error: null })
        .where(and(eq(table.seq, seq), eq(table.withdrawn, 0), isNull(table.delivery)))
        .run().changes;
    },
    markDispatched(seq: number, runId: string): number {
      return db
        .update(table)
        .set({ delivery: 'sending' })
        .where(and(eq(table.seq, seq), eq(table.targetRunId, runId), eq(table.delivery, 'waiting')))
        .run().changes;
    },
    consumeSending(seq: number, runId: string): number {
      return db
        .delete(table)
        .where(and(eq(table.seq, seq), eq(table.targetRunId, runId), eq(table.delivery, 'sending')))
        .run().changes;
    },
    releaseLive(seq: number, runId: string): void {
      const released = db
        .update(table)
        .set({ delivery: null, targetRunId: null, error: null })
        .where(and(eq(table.seq, seq), eq(table.targetRunId, runId), eq(table.delivery, 'waiting')))
        .run().changes;
      if (released) return;
      db.update(table)
        .set({ delivery: 'unknown', error: missingReceipt })
        .where(and(eq(table.seq, seq), eq(table.targetRunId, runId), eq(table.delivery, 'sending')))
        .run();
    },
    withdraw(sessionId: string, id: string): number {
      return db
        .update(table)
        .set({ withdrawn: 1, data: '{}', error: null })
        .where(
          and(
            eq(table.id, id),
            eq(table.sessionId, sessionId),
            eq(table.withdrawn, 0),
            or(isNull(table.delivery), eq(table.delivery, 'unknown')),
          ),
        )
        .run().changes;
    },
    block(seq: number, message: string): number {
      return db
        .update(table)
        .set({ error: message })
        .where(and(eq(table.seq, seq), eq(table.withdrawn, 0)))
        .run().changes;
    },
    resume(sessionId: string): void {
      db.update(table)
        .set({ paused: 0, error: null })
        .where(and(eq(table.sessionId, sessionId), eq(table.withdrawn, 0), isNull(table.delivery)))
        .run();
    },
    listSessionPayloads(sessionId: string): string[] {
      return db
        .select({ data: table.data })
        .from(table)
        .where(and(eq(table.sessionId, sessionId), eq(table.withdrawn, 0)))
        .all()
        .map((row) => row.data);
    },
  };
}
