/**
 * @file 展示当前会话输入区上方的待处理消息队列。
 * @implementation 按权威快照显示紧凑消息、投递与暂停状态，保留全文展开，并通过会话隔离的 hook 插入、撤回或继续。
 * @updated 2026-11-21T00:15:48+08:00
 */
import { useId } from 'react';
import type { Run, SessionMessageQueue } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useSessionMessageQueue } from './hooks/use-session-message-queue';

export function MessageQueue({
  sessionId,
  queue,
  archived,
  available,
  activeRun,
}: {
  sessionId: string;
  queue: SessionMessageQueue;
  archived: boolean;
  available: boolean;
  activeRun?: Run;
}) {
  const actions = useSessionMessageQueue(sessionId);
  const priorityDescriptionId = useId();
  const canInsert =
    activeRun?.sessionId === sessionId &&
    (activeRun.status === 'running' || activeRun.status === 'awaiting_permission');
  if (!queue.items.length && !actions.error) return null;
  return (
    <section className="chat-message-queue" aria-label="待处理消息">
      <div className="chat-message-queue-header">
        <span role="status">
          待处理消息 · {queue.items.length}
          {queue.paused ? ' · 已暂停' : ' · 按顺序发送'}
        </span>
        {queue.paused && queue.items.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={archived || !available || actions.busy}
            onClick={actions.onResume}
          >
            {actions.resuming ? '正在继续…' : '继续队列'}
          </Button>
        ) : null}
      </div>
      <p id={priorityDescriptionId} className="sr-only">
        优先执行会停止当前轮，再执行这条消息。
      </p>
      {queue.items.length > 0 ? (
        <ol className="chat-message-queue-items">
          {queue.items.map((item, index) => {
            const deliveryPending = item.delivery === 'waiting' || item.delivery === 'sending';
            const deliveryLabel =
              item.delivery === 'waiting'
                ? '等待发送'
                : item.delivery === 'sending'
                  ? '发送中…'
                  : item.delivery === 'unknown'
                    ? '结果待确认'
                    : undefined;
            return (
              <li key={item.id} className="chat-message-queue-item">
                <span className="chat-message-queue-position" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="chat-message-queue-copy">
                  <details>
                    <summary title={item.text} aria-label={`查看消息 ${index + 1}：${item.text}`}>
                      <span className="truncate">{item.text}</span>
                    </summary>
                    <p className="chat-message-queue-text">{item.text}</p>
                  </details>
                  {item.error ? <p className="chat-message-queue-error">{item.error}</p> : null}
                </div>
                <div className="chat-message-queue-actions">
                  {deliveryLabel ? (
                    <span className="chat-message-queue-delivery" role="status">
                      {deliveryLabel}
                    </span>
                  ) : null}
                  {item.insertion ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        archived || !available || actions.busy || !canInsert || !!item.delivery
                      }
                      aria-label={`${item.insertion === 'live' ? '立即插入' : '优先执行'}消息 ${index + 1}`}
                      aria-describedby={
                        item.insertion === 'priority' ? priorityDescriptionId : undefined
                      }
                      onClick={() => {
                        if (!canInsert || !activeRun || item.delivery || !item.insertion) return;
                        actions.onInsert({
                          itemId: item.id,
                          runId: activeRun.id,
                          mode: item.insertion,
                        });
                      }}
                    >
                      {actions.insertingId === item.id
                        ? item.insertion === 'live'
                          ? '插入中…'
                          : '正在优先执行…'
                        : item.insertion === 'live'
                          ? '立即插入'
                          : '优先执行'}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={archived || actions.busy || deliveryPending}
                    aria-label={`撤回消息 ${index + 1}`}
                    onClick={() => actions.onWithdraw(item.id)}
                  >
                    {actions.withdrawingId === item.id ? '撤回中…' : '撤回'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {actions.error ? (
        <p className="chat-message-queue-error" role="alert">
          {actions.error}
        </p>
      ) : null}
    </section>
  );
}
