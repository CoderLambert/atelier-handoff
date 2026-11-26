/**
 * @file 执行会话待处理消息的插入、撤回与恢复。
 * @implementation 查询目标运行和已投递回执，复核插入模式；状态修改后发事件并请求调度。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { AppError, type Session } from '../../../shared/types.js';
import type { Runner } from '../../agent.js';
import type { MessageQueue } from '../../message-queue.js';
import type { Store } from '../../store.js';
import type { DevelopmentWorktrees } from '../git/development-worktrees.js';
import type { LiveInsertion } from './live-insertion.js';

export function createQueueActions({
  store,
  messageQueue,
  runner,
  liveInsertion,
  worktrees,
  queueChanged,
  wakeQueue,
}: {
  store: Pick<Store, 'get' | 'list' | 'gitWorktrees'>;
  messageQueue: Pick<MessageQueue, 'pending' | 'prioritize' | 'withdraw' | 'resume'>;
  runner: Pick<Runner, 'stop'>;
  liveInsertion: Pick<LiveInsertion, 'insertionAction' | 'insertLive'>;
  worktrees: Pick<DevelopmentWorktrees, 'resolveSession'>;
  queueChanged(id: string): void;
  wakeQueue(): void;
}) {
  const notify = (id: string) => {
    queueChanged(id);
    wakeQueue();
  };

  return {
    async insert(id: string, itemId: string, runId: string, mode: 'live' | 'priority') {
      const active = store.get('runs', runId);
      if (active.sessionId !== id)
        throw new AppError('QUEUE_CHANGED', '消息和当前运行不属于同一会话。', 409);
      const item = messageQueue.pending(id, itemId);
      if (
        !item &&
        store.list('messages').some((message) => message.id === itemId && message.runId === runId)
      )
        return;
      if (
        item?.target_run_id === runId &&
        (item.delivery === 'waiting' || item.delivery === 'sending')
      )
        return;
      if (
        !item ||
        item.delivery ||
        !['running', 'awaiting_permission'].includes(active.status) ||
        mode !== liveInsertion.insertionAction(item, active)
      )
        throw new AppError('QUEUE_CHANGED', '当前运行或排队消息已变化，请刷新后重试。', 409);
      if (mode === 'priority') {
        messageQueue.prioritize(item);
        runner.stop(runId);
        notify(id);
        return;
      }
      await liveInsertion.insertLive(item, active, 'now');
    },
    withdraw(id: string, itemId: string) {
      messageQueue.withdraw(id, itemId);
      notify(id);
    },
    async resume(session: Session) {
      const { id } = session;
      if (session.status !== 'active')
        throw new AppError('SESSION_ARCHIVED', '请先恢复归档会话。', 409);
      if (store.gitWorktrees.forSession(id)) await worktrees.resolveSession(session);
      messageQueue.resume(id);
      notify(id);
    },
  };
}

export type QueueActions = ReturnType<typeof createQueueActions>;
