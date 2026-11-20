/**
 * @file 保存会话按序等待启动的消息。
 * @implementation 使用 SQLite 保留入队顺序和提交回执，提供会话快照、撤回和重启恢复所需的操作。
 * @updated 2026-11-20T22:30:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now, type QueuedSessionMessage } from '../shared/types.js';
import type { Store } from './store.js';

const rowSchema = z.object({
  seq: z.number(),
  id: z.string(),
  session_id: z.string(),
  request_key: z.string(),
  body_hash: z.string(),
  withdrawn: z.number(),
  paused: z.number(),
  error: z.string().nullable(),
  data: z.string(),
});
const summarySchema = z.object({
  text: z.string(),
  createdAt: z.string(),
  extensions: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum(['command', 'skill', 'mcp']),
        name: z.string(),
        version: z.number(),
        tools: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

type QueueRow = z.infer<typeof rowSchema>;
export type PendingSessionMessage = QueueRow & { intent: unknown };

export class MessageQueue {
  constructor(private readonly store: Store) {
    store.db.prepare('UPDATE pending_messages SET paused=1 WHERE withdrawn=0').run();
  }

  receipt(key: string, bodyHash: string): QueuedSessionMessage | undefined {
    const raw = this.store.db
      .prepare('SELECT * FROM pending_messages WHERE request_key=?')
      .get(key);
    if (!raw) return undefined;
    const row = rowSchema.parse(raw);
    if (row.body_hash !== bodyHash)
      throw new AppError('IDEMPOTENCY_CONFLICT', '同一请求编号不能用于不同内容。', 409);
    if (row.withdrawn) throw new AppError('QUEUE_WITHDRAWN', '这条待处理消息已撤回。', 409);
    return this.summary(row);
  }

  private summary(row: QueueRow): QueuedSessionMessage {
    return { id: row.id, ...summarySchema.parse(JSON.parse(row.data)), error: row.error };
  }

  enqueue(
    sessionId: string,
    key: string,
    hash: string,
    summary: { text: string; extensions?: QueuedSessionMessage['extensions'] },
    intent: unknown,
  ) {
    const id = randomUUID();
    const createdAt = now();
    this.store.db
      .prepare(
        `
      INSERT INTO pending_messages(id,session_id,request_key,body_hash,data,paused)
      VALUES(?,?,?,?,?,EXISTS(SELECT 1 FROM pending_messages WHERE session_id=? AND withdrawn=0 AND paused=1))
    `,
      )
      .run(id, sessionId, key, hash, JSON.stringify({ ...summary, createdAt, intent }), sessionId);
    return { id, ...summary, createdAt, error: null } satisfies QueuedSessionMessage;
  }

  hasPending(sessionId: string) {
    return Boolean(
      this.store.db
        .prepare('SELECT 1 FROM pending_messages WHERE session_id=? AND withdrawn=0 LIMIT 1')
        .get(sessionId),
    );
  }

  snapshot(sessionId: string) {
    const rows = this.store.db
      .prepare('SELECT * FROM pending_messages WHERE session_id=? AND withdrawn=0 ORDER BY seq')
      .all(sessionId)
      .map((row) => rowSchema.parse(row));
    return {
      items: rows.map((row) => this.summary(row)),
      paused: rows.some((row) => Boolean(row.paused)) || Boolean(rows[0]?.error),
    };
  }

  heads(): PendingSessionMessage[] {
    return this.store.db
      .prepare(
        `
      SELECT * FROM pending_messages WHERE seq IN (
        SELECT min(seq) FROM pending_messages WHERE withdrawn=0 GROUP BY session_id
      ) AND paused=0 AND error IS NULL ORDER BY seq
    `,
      )
      .all()
      .map((raw) => {
        const row = rowSchema.parse(raw);
        return {
          ...row,
          intent: z.object({ intent: z.unknown() }).parse(JSON.parse(row.data)).intent,
        };
      });
  }

  consume(item: PendingSessionMessage) {
    const result = this.store.db
      .prepare(
        `
      DELETE FROM pending_messages WHERE seq=? AND withdrawn=0 AND paused=0 AND error IS NULL
        AND seq=(SELECT min(seq) FROM pending_messages WHERE session_id=? AND withdrawn=0)
    `,
      )
      .run(item.seq, item.session_id);
    if (Number(result.changes) !== 1)
      throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  withdraw(sessionId: string, id: string) {
    const result = this.store.db
      .prepare(
        `
      UPDATE pending_messages SET withdrawn=1, data='{}', error=NULL WHERE id=? AND session_id=? AND withdrawn=0
    `,
      )
      .run(id, sessionId);
    if (Number(result.changes) !== 1)
      throw new AppError('QUEUE_CHANGED', '消息已启动或已撤回。', 409);
  }

  block(item: PendingSessionMessage, message: string) {
    return (
      Number(
        this.store.db
          .prepare('UPDATE pending_messages SET error=? WHERE seq=? AND withdrawn=0')
          .run(message, item.seq).changes,
      ) !== 0
    );
  }

  resume(sessionId: string) {
    this.store.db
      .prepare('UPDATE pending_messages SET paused=0,error=NULL WHERE session_id=? AND withdrawn=0')
      .run(sessionId);
  }

  referencesAttachment(sessionId: string, id: string) {
    return Boolean(
      this.store.db
        .prepare(
          `
      SELECT 1 FROM pending_messages p, json_each(p.data,'$.intent.request.attachmentIds') a
      WHERE p.session_id=? AND p.withdrawn=0 AND a.value=? LIMIT 1
    `,
        )
        .get(sessionId, id),
    );
  }
}
