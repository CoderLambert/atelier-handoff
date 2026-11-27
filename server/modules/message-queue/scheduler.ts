/**
 * @file 调度待处理消息的下一步执行。
 * @implementation 合并唤醒，在活动运行允许时插入，否则通过执行槽创建下一轮。启动失败时阻塞消息并保留授权变化错误码，关停时等待在途 drain。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { AppError, type RunEvent, type Session } from '../../../shared/types.js';
import type { Runner } from '../../agent.js';
import { queueScopeChanged, type MessageQueue } from '../../message-queue.js';
import type { Store } from '../../store.js';
import type { StartRun } from '../runs/create-run.js';
import type { LiveInsertion } from './live-insertion.js';

export function createQueueScheduler({
  store,
  messageQueue,
  runner,
  liveInsertion,
  sessionDirectory,
  assertExecutionSlot,
  createRun,
  queueChanged,
  isShuttingDown,
  listenForRunEvents,
}: {
  store: Pick<Store, 'get' | 'events' | 'repos'>;
  messageQueue: Pick<MessageQueue, 'heads' | 'block'>;
  runner: Pick<Runner, 'canInsertNext'>;
  liveInsertion: Pick<LiveInsertion, 'insertionMode' | 'insertLive'>;
  sessionDirectory(session: Session): string;
  assertExecutionSlot(sessionId: string, path: string): void;
  createRun: StartRun;
  queueChanged(sessionId: string): void;
  isShuttingDown(): boolean;
  listenForRunEvents: boolean;
}) {
  const { insertionMode, insertLive } = liveInsertion;
  let drain: Promise<void> | undefined;
  let wakeRequested = false;
  function wakeQueue() {
    if (isShuttingDown()) return;
    wakeRequested = true;
    if (drain) return;
    drain = Promise.resolve()
      .then(async () => {
        while (wakeRequested && !isShuttingDown()) {
          wakeRequested = false;
          for (const item of messageQueue.heads()) {
            if (isShuttingDown()) break;
            try {
              const session = store.get('sessions', item.session_id);
              const active = store.repos.runs.findActiveBySession(session.id);
              if (
                active &&
                runner.canInsertNext?.(active.id) &&
                insertionMode(item, active) === 'live'
              ) {
                await insertLive(item, active, 'next');
                continue;
              }
              assertExecutionSlot(session.id, sessionDirectory(session));
              await createRun(session.id, undefined, null, item);
            } catch (error) {
              if (isShuttingDown()) break;
              if (
                error instanceof AppError &&
                [
                  'RUN_ACTIVE',
                  'SERVER_BUSY',
                  'QUEUE_CHANGED',
                  'GIT_DIRECTORY_BUSY',
                  'LIVE_INPUT_BUSY',
                  'LIVE_INPUT_UNAVAILABLE',
                ].includes(error.code)
              )
                continue;
              const reason =
                error instanceof AppError
                  ? error.code === queueScopeChanged
                    ? queueScopeChanged
                    : error.message
                  : '无法启动这条消息，请检查运行设置。';
              if (messageQueue.block(item, reason)) queueChanged(item.session_id);
            }
          }
        }
      })
      .catch(() => {
        console.error('无法读取待处理消息。');
      })
      .finally(() => {
        drain = undefined;
        if (wakeRequested) wakeQueue();
      });
  }
  const wakeAfterRun = (event: RunEvent) => {
    if (event.type === 'run.finished') wakeQueue();
  };
  if (listenForRunEvents) store.events.on('event', wakeAfterRun);
  return {
    wake: wakeQueue,
    waitForDrain: () => drain,
    detachRunnerEvents: () => store.events.off('event', wakeAfterRun),
  };
}
