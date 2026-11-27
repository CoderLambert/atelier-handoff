/**
 * @file 展示当前会话输入区上方的待处理消息队列。
 * @implementation 按快照显示消息、投递和暂停状态，支持展开正文及插入、撤回。队首授权范围变化时要求用户确认后继续。
 * @updated 2026-11-27T02:25:28+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useId, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Run, SessionMessageQueue } from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  const { t } = useUiTranslation('chat');
  const actions = useSessionMessageQueue(sessionId);
  const resumeButton = useRef<HTMLButtonElement>(null);
  const [reviewId, setReviewId] = useState<string>();
  const head = queue.items.find((item) => !item.delivery);
  const needsReview = head?.scopeChanged === true;
  const resumeDisabled = archived || !available || actions.busy || (needsReview && !!activeRun);
  const priorityDescriptionId = useId();
  const canInsert =
    activeRun?.sessionId === sessionId &&
    (activeRun.status === 'running' || activeRun.status === 'awaiting_permission');
  if (!queue.items.length && !actions.error) return null;
  return (
    <section
      className="chat-message-queue"
      data-paused={queue.paused}
      aria-label={t('queue.label')}
    >
      <div className="chat-message-queue-header">
        <span role="status">
          {t('queue.summary', {
            count: queue.items.length,
            status: t(queue.paused ? 'queue.paused' : 'queue.ordered'),
          })}
        </span>
        {queue.paused && queue.items.length > 0 ? (
          <Button
            ref={resumeButton}
            size="xs"
            variant="outline"
            disabled={resumeDisabled}
            onClick={() => {
              if (needsReview) setReviewId(head.id);
              else actions.onResume();
            }}
          >
            {t(actions.resuming ? 'queue.resuming' : needsReview ? 'queue.review' : 'queue.resume')}
          </Button>
        ) : null}
      </div>
      <p id={priorityDescriptionId} className="sr-only">
        {t('queue.priorityHelp')}
      </p>
      {queue.items.length > 0 ? (
        <ol className="chat-message-queue-items">
          {queue.items.map((item, index) => {
            const deliveryPending = item.delivery === 'waiting' || item.delivery === 'sending';
            const deliveryLabel =
              item.delivery === 'waiting'
                ? t('queue.waiting')
                : item.delivery === 'sending'
                  ? t('queue.sending')
                  : item.delivery === 'unknown'
                    ? t('queue.unknown')
                    : undefined;
            return (
              <li key={item.id} className="chat-message-queue-item">
                <span className="chat-message-queue-position" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="chat-message-queue-copy">
                  <details>
                    <summary
                      title={item.text}
                      aria-label={t('queue.viewMessage', { number: index + 1, text: item.text })}
                    >
                      <ChevronRight
                        data-icon="inline-start"
                        className="chat-message-queue-chevron"
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.text}</span>
                    </summary>
                    <p className="chat-message-queue-text">{item.text}</p>
                  </details>
                  {item.error ? (
                    <p className="chat-message-queue-error">
                      {item.scopeChanged ? t('queue.scopeChanged') : item.error}
                    </p>
                  ) : null}
                </div>
                <div className="chat-message-queue-actions">
                  {deliveryLabel ? (
                    <span
                      className="chat-message-queue-delivery"
                      data-delivery={item.delivery}
                      role="status"
                    >
                      {deliveryLabel}
                    </span>
                  ) : null}
                  {item.insertion ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={
                        archived || !available || actions.busy || !canInsert || !!item.delivery
                      }
                      aria-label={t(
                        item.insertion === 'live'
                          ? 'queue.insertMessage'
                          : 'queue.prioritizeMessage',
                        { number: index + 1 },
                      )}
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
                          ? t('queue.inserting')
                          : t('queue.prioritizing')
                        : item.insertion === 'live'
                          ? t('queue.insert')
                          : t('queue.prioritize')}
                    </Button>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={archived || actions.busy || deliveryPending}
                    aria-label={t('queue.withdrawMessage', { number: index + 1 })}
                    onClick={() => actions.onWithdraw(item.id)}
                  >
                    {actions.withdrawingId === item.id
                      ? t('queue.withdrawing')
                      : t('queue.withdraw')}
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
      {reviewId && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setReviewId(undefined);
          }}
        >
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              resumeButton.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('queue.reviewTitle')}</DialogTitle>
              <DialogDescription>{t('queue.reviewDescription')}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setReviewId(undefined)}>
                {t('queue.reviewCancel')}
              </Button>
              <Button
                disabled={resumeDisabled || !needsReview || head.id !== reviewId}
                onClick={() => {
                  actions.onResume(reviewId);
                  setReviewId(undefined);
                }}
              >
                {t('queue.reviewConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
