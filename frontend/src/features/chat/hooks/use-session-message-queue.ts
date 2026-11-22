/**
 * @file 编排会话消息队列的插入、撤回与继续操作。
 * @implementation 组合具名 mutations，以会话键追踪在途操作并阻止重复点击；按用户选择发送插入模式，错误留在当前队列界面，队列内容由快照同步。
 * @updated 2026-11-21T00:15:48+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { sessionKeys } from '@/use-query/sessions/keys';
import {
  useInsertQueuedMessage,
  type InsertQueuedMessageVariables,
} from '@/use-query/sessions/use-insert-queued-message';
import { useResumeMessageQueue } from '@/use-query/sessions/use-resume-message-queue';
import { useWithdrawQueuedMessage } from '@/use-query/sessions/use-withdraw-queued-message';

type QueueAction =
  | { type: 'withdraw'; itemId: string }
  | { type: 'resume' }
  | { type: 'insert'; variables: InsertQueuedMessageVariables };

export function useSessionMessageQueue(sessionId: string) {
  const { t } = useUiTranslation('chat');
  const withdraw = useWithdrawQueuedMessage(sessionId);
  const resume = useResumeMessageQueue(sessionId);
  const insert = useInsertQueuedMessage(sessionId);
  const pending = useIsMutating({ mutationKey: sessionKeys.messageQueue(sessionId) });
  const lock = useRef(false);
  const [failure, setFailure] = useState<{ action: QueueAction; cause: unknown }>();
  const busy = pending > 0 || withdraw.isPending || resume.isPending || insert.isPending;

  async function act(action: QueueAction) {
    if (lock.current || busy) return;
    lock.current = true;
    setFailure(undefined);
    try {
      if (action.type === 'withdraw') await withdraw.mutateAsync(action.itemId);
      else if (action.type === 'resume') await resume.mutateAsync();
      else await insert.mutateAsync(action.variables);
    } catch (failure) {
      setFailure({ action, cause: failure });
    } finally {
      lock.current = false;
    }
  }

  return {
    busy,
    error: failure
      ? translateError(
          failure.cause,
          t(
            failure.action.type === 'withdraw'
              ? 'queue.withdrawFailed'
              : failure.action.type === 'resume'
                ? 'queue.resumeFailed'
                : failure.action.variables.mode === 'live'
                  ? 'queue.insertFailed'
                  : 'queue.prioritizeFailed',
          ),
        )
      : '',
    withdrawingId: withdraw.isPending ? withdraw.variables : undefined,
    insertingId: insert.isPending ? insert.variables?.itemId : undefined,
    resuming: resume.isPending,
    onWithdraw: (itemId: string) => void act({ type: 'withdraw', itemId }),
    onResume: () => void act({ type: 'resume' }),
    onInsert: (variables: InsertQueuedMessageVariables) => void act({ type: 'insert', variables }),
  };
}
