/**
 * @file 交接已持久化的运行给执行器。
 * @implementation 在提交之后启动 runner，保留启动失败的持久事件和后续队列唤醒时机。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { activeStatuses, now, type Run } from '../../../shared/types.js';
import type { Runner } from '../../agent.js';
import type { Store } from '../../store.js';

export function startAcceptedRun(
  store: Pick<Store, 'get' | 'update' | 'event'>,
  runner: Pick<Runner, 'start'>,
  wakeQueue: () => void,
  run: Run,
  ...input: Parameters<Runner['start']> extends [Run, ...infer Input] ? Input : never
): void {
  const startFailed = () => {
    const current = store.get('runs', run.id);
    if (activeStatuses.includes(current.status)) {
      const error = '无法启动本轮。请检查运行设置后重试。';
      store.update('runs', run.id, { status: 'failed', error, reason: error, endedAt: now() });
      store.event(run.id, run.sessionId, 'run.finished', { status: 'failed', reason: error });
    }
  };
  try {
    const done = runner.start(run, ...input);
    if (done) void done.catch(startFailed).finally(wakeQueue);
  } catch {
    startFailed();
    wakeQueue();
  }
}
