/**
 * @file 管理待处理消息与实时插入状态。
 * @implementation 使用 SQLite 保存顺序、优先级和提交回执，跟踪实时投递及中断后的待确认消息，并将新旧授权范围错误统一映射为待复核状态。
 * @updated 2026-11-27T02:25:28+08:00
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now, type QueuedSessionMessage } from '../shared/types.js';
import type { Store } from './store.js';

const rowSchema = z.object({
  seq: z.number(),
  id: z.custom<ReturnType<typeof randomUUID>>(
    (value) => z.string().uuid().safeParse(value).success,
  ),
  session_id: z.string(),
  request_key: z.string(),
  body_hash: z.string(),
  withdrawn: z.number(),
  paused: z.number(),
  error: z.string().nullable(),
  delivery: z.enum(['waiting', 'sending', 'unknown']).nullable(),
  target_run_id: z.string().nullable(),
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
export const queueScopeChanged = 'QUEUE_SCOPE_CHANGED';
const legacyScopeError = '排队时的智能体、扩展或浏览器授权已变化。请撤回并重新发送。';

export function hasQueueScopeError(error: string | null) {
  return (
    error === queueScopeChanged ||
    error === legacyScopeError ||
    error === '智能体、扩展或浏览器授权已变化。请重新发送。'
  );
}

export class MessageQueue {
  constructor(private readonly store: Store) {
    store.db.exec(`UPDATE pending_messages SET paused=1 WHERE withdrawn=0;
      UPDATE pending_messages SET delivery='unknown', error='运行中断，插入结果待确认。' WHERE delivery='sending';
      UPDATE pending_messages SET delivery=NULL,target_run_id=NULL WHERE delivery='waiting';`);
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
    const scopeChanged = hasQueueScopeError(row.error);
    return {
      id: row.id,
      ...summarySchema.parse(JSON.parse(row.data)),
      error: scopeChanged ? '排队时的授权范围已变化，请复核后继续。' : row.error,
      ...(scopeChanged ? { scopeChanged: true as const } : {}),
      ...(row.delivery ? { delivery: row.delivery } : {}),
    };
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
      VALUES(?,?,?,?,?,EXISTS(SELECT 1 FROM pending_messages WHERE session_id=? AND withdrawn=0 AND delivery IS NULL AND paused=1))
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

  snapshot(
    sessionId: string,
    action?: (item: PendingSessionMessage) => QueuedSessionMessage['insertion'],
  ) {
    const rows = this.store.db
      .prepare(
        'SELECT * FROM pending_messages WHERE session_id=? AND withdrawn=0 ORDER BY priority DESC,seq',
      )
      .all(sessionId)
      .map((row) => rowSchema.parse(row));
    const pending = rows.filter((row) => row.delivery === null);
    return {
      items: rows.map((row) => ({
        ...this.summary(row),
        ...(action ? { insertion: action(this.item(row)) } : {}),
      })),
      paused: pending.some((row) => Boolean(row.paused)) || Boolean(pending[0]?.error),
    };
  }

  private item(row: QueueRow): PendingSessionMessage {
    return { ...row, intent: z.object({ intent: z.unknown() }).parse(JSON.parse(row.data)).intent };
  }

  pending(sessionId: string, id: string) {
    const raw = this.store.db
      .prepare('SELECT * FROM pending_messages WHERE session_id=? AND id=? AND withdrawn=0')
      .get(sessionId, id);
    return raw ? this.item(rowSchema.parse(raw)) : undefined;
  }

  heads(): PendingSessionMessage[] {
    return this.store.db
      .prepare(
        `
      SELECT * FROM pending_messages WHERE seq IN (
        SELECT seq FROM (
          SELECT seq,row_number() OVER (PARTITION BY session_id ORDER BY priority DESC,seq) AS position
          FROM pending_messages WHERE withdrawn=0 AND delivery IS NULL
        ) WHERE position=1
      ) AND paused=0 AND error IS NULL ORDER BY seq
    `,
      )
      .all()
      .map((row) => this.item(rowSchema.parse(row)));
  }

  consume(item: PendingSessionMessage) {
    const result = this.store.db
      .prepare(
        `
      DELETE FROM pending_messages WHERE seq=? AND withdrawn=0 AND delivery IS NULL AND paused=0 AND error IS NULL
        AND seq=(SELECT seq FROM pending_messages WHERE session_id=? AND withdrawn=0 AND delivery IS NULL ORDER BY priority DESC,seq LIMIT 1)
    `,
      )
      .run(item.seq, item.session_id);
    if (Number(result.changes) !== 1)
      throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  prioritize(item: PendingSessionMessage) {
    const changes = this.store.db
      .prepare(
        `
      UPDATE pending_messages SET priority=(SELECT coalesce(max(priority),0)+1 FROM pending_messages WHERE session_id=?),paused=0,error=NULL
      WHERE seq=? AND withdrawn=0 AND delivery IS NULL
    `,
      )
      .run(item.session_id, item.seq).changes;
    if (!Number(changes)) throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  beginLive(item: PendingSessionMessage, runId: string) {
    const changes = this.store.db
      .prepare(
        `UPDATE pending_messages SET delivery='waiting',target_run_id=?,error=NULL WHERE seq=? AND withdrawn=0 AND delivery IS NULL`,
      )
      .run(runId, item.seq).changes;
    if (!Number(changes)) throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  dispatched(item: PendingSessionMessage, runId: string) {
    const changes = this.store.db
      .prepare(
        `UPDATE pending_messages SET delivery='sending' WHERE seq=? AND target_run_id=? AND delivery='waiting'`,
      )
      .run(item.seq, runId).changes;
    if (!Number(changes)) throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  confirmLive(item: PendingSessionMessage, runId: string) {
    this.store.transaction(() => {
      const changes = this.store.db
        .prepare(
          `DELETE FROM pending_messages WHERE seq=? AND target_run_id=? AND delivery='sending'`,
        )
        .run(item.seq, runId).changes;
      if (Number(changes))
        this.store.db
          .prepare('INSERT INTO idempotency(key,body_hash,run_id) VALUES(?,?,?)')
          .run(item.request_key, item.body_hash, runId);
    });
  }

  releaseLive(item: PendingSessionMessage, runId: string) {
    this.store.db
      .prepare(
        `
      UPDATE pending_messages SET delivery=CASE WHEN delivery='sending' THEN 'unknown' END,
        target_run_id=CASE WHEN delivery='sending' THEN target_run_id END,
        error=CASE WHEN delivery='sending' THEN '未收到 SDK 回执，请核对会话结果。' END
      WHERE seq=? AND target_run_id=? AND delivery IN ('waiting','sending')
    `,
      )
      .run(item.seq, runId);
  }

  withdraw(sessionId: string, id: string) {
    const result = this.store.db
      .prepare(
        `
      UPDATE pending_messages SET withdrawn=1, data='{}', error=NULL WHERE id=? AND session_id=? AND withdrawn=0 AND (delivery IS NULL OR delivery='unknown')
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
      .prepare(
        'UPDATE pending_messages SET paused=0,error=NULL WHERE session_id=? AND withdrawn=0 AND delivery IS NULL',
      )
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
