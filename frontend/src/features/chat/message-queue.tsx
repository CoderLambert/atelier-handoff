/**
 * @file 展示当前会话输入区上方的待处理消息队列。
 * @implementation 按服务端快照顺序显示可展开全文的紧凑消息、失败与暂停状态，使用现有 Button 和会话隔离的动作 hook 撤回或继续。
 * @updated 2026-11-20T23:09:03+08:00
 */
import type { SessionMessageQueue } from '@shared/types';
import { Button } from '@/components/ui/button';
import { useSessionMessageQueue } from './hooks/use-session-message-queue';

export function MessageQueue({
  sessionId,
  queue,
  archived,
  available,
}: {
  sessionId: string;
  queue: SessionMessageQueue;
  archived: boolean;
  available: boolean;
}) {
  const actions = useSessionMessageQueue(sessionId);
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
      {queue.items.length > 0 ? (
        <ol className="chat-message-queue-items">
          {queue.items.map((item, index) => (
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
              <Button
                size="sm"
                variant="ghost"
                disabled={archived || actions.busy}
                aria-label={`撤回消息 ${index + 1}`}
                onClick={() => actions.onWithdraw(item.id)}
              >
                {actions.withdrawingId === item.id ? '撤回中…' : '撤回'}
              </Button>
            </li>
          ))}
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
