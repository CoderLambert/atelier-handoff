/**
 * @file 管理待处理消息与实时插入状态。
 * @implementation 经队列仓储保存顺序、优先级和提交回执，跟踪实时投递及中断后的待确认消息，并将新旧授权范围错误统一映射为待复核状态。中断恢复由运行恢复用例统一完成。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now, type QueuedSessionMessage } from '../shared/types.js';
import type { Store } from './store.js';

type PendingMessageRow = NonNullable<
  ReturnType<Store['repos']['messageQueue']['findByRequestKey']>
>;

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

const attachmentIdsSchema = z.object({
  intent: z.object({ request: z.object({ attachmentIds: z.array(z.string()) }) }),
});

export class MessageQueue {
  constructor(private readonly store: Pick<Store, 'repos' | 'transaction'>) {}

  private get queue() {
    return this.store.repos.messageQueue;
  }

  private toQueueRow(row: PendingMessageRow): QueueRow {
    return rowSchema.parse({
      seq: row.seq,
      id: row.id,
      session_id: row.sessionId,
      request_key: row.requestKey,
      body_hash: row.bodyHash,
      withdrawn: row.withdrawn,
      paused: row.paused,
      error: row.error,
      delivery: row.delivery,
      target_run_id: row.targetRunId,
      data: row.data,
    });
  }

  receipt(key: string, bodyHash: string): QueuedSessionMessage | undefined {
    const raw = this.queue.findByRequestKey(key);
    if (!raw) return undefined;
    const row = this.toQueueRow(raw);
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
    this.queue.enqueue({
      id,
      sessionId,
      requestKey: key,
      bodyHash: hash,
      data: JSON.stringify({ ...summary, createdAt, intent }),
    });
    return { id, ...summary, createdAt, error: null } satisfies QueuedSessionMessage;
  }

  hasPending(sessionId: string) {
    return this.queue.hasPending(sessionId);
  }

  snapshot(
    sessionId: string,
    action?: (item: PendingSessionMessage) => QueuedSessionMessage['insertion'],
  ) {
    const rows = this.queue.listBySession(sessionId).map((row) => this.toQueueRow(row));
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
    const raw = this.queue.findPending(sessionId, id);
    return raw ? this.item(this.toQueueRow(raw)) : undefined;
  }

  heads(): PendingSessionMessage[] {
    return this.queue.listHeads().map((row) => this.item(this.toQueueRow(row)));
  }

  consume(item: PendingSessionMessage) {
    if (this.queue.consumeHead(item.seq, item.session_id) !== 1)
      throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  prioritize(item: PendingSessionMessage) {
    if (!this.queue.prioritize(item.seq, item.session_id))
      throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  beginLive(item: PendingSessionMessage, runId: string) {
    if (!this.queue.beginLive(item.seq, runId))
      throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  dispatched(item: PendingSessionMessage, runId: string) {
    if (!this.queue.markDispatched(item.seq, runId))
      throw new AppError('QUEUE_CHANGED', '待处理消息已变化。', 409);
  }

  confirmLive(item: PendingSessionMessage, runId: string) {
    this.store.transaction(() => {
      if (this.queue.consumeSending(item.seq, runId))
        this.store.repos.runReceipts.insert(item.request_key, item.body_hash, runId);
    });
  }

  releaseLive(item: PendingSessionMessage, runId: string) {
    this.queue.releaseLive(item.seq, runId);
  }

  withdraw(sessionId: string, id: string) {
    if (this.queue.withdraw(sessionId, id) !== 1)
      throw new AppError('QUEUE_CHANGED', '消息已启动或已撤回。', 409);
  }

  block(item: PendingSessionMessage, message: string) {
    return this.queue.block(item.seq, message) !== 0;
  }

  resume(sessionId: string) {
    this.queue.resume(sessionId);
  }

  referencesAttachment(sessionId: string, id: string) {
    return this.queue.listSessionPayloads(sessionId).some((data) => {
      try {
        const parsed = attachmentIdsSchema.safeParse(JSON.parse(data));
        return parsed.success && parsed.data.intent.request.attachmentIds.includes(id);
      } catch {
        return false;
      }
    });
  }
}
