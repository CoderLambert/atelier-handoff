/**
 * @file 编排会话消息队列的撤回与继续操作。
 * @implementation 组合具名 mutations，以会话键追踪在途操作并阻止重复点击；错误留在当前队列界面，队列内容由快照同步。
 * @updated 2026-11-20T23:09:03+08:00
 */
import { useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { sessionKeys } from '@/use-query/sessions/keys';
import { useResumeMessageQueue } from '@/use-query/sessions/use-resume-message-queue';
import { useWithdrawQueuedMessage } from '@/use-query/sessions/use-withdraw-queued-message';

export function useSessionMessageQueue(sessionId: string) {
  const withdraw = useWithdrawQueuedMessage(sessionId);
  const resume = useResumeMessageQueue(sessionId);
  const pending = useIsMutating({ mutationKey: sessionKeys.messageQueue(sessionId) });
  const lock = useRef(false);
  const [error, setError] = useState('');
  const busy = pending > 0 || withdraw.isPending || resume.isPending;

  async function act(action: 'withdraw' | 'resume', itemId?: string) {
    if (lock.current || busy) return;
    lock.current = true;
    setError('');
    try {
      if (action === 'withdraw' && itemId) await withdraw.mutateAsync(itemId);
      else if (action === 'resume') await resume.mutateAsync();
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : '请重试';
      setError(`${action === 'withdraw' ? '撤回' : '继续队列'}失败：${detail}`);
    } finally {
      lock.current = false;
    }
  }

  return {
    busy,
    error,
    withdrawingId: withdraw.isPending ? withdraw.variables : undefined,
    resuming: resume.isPending,
    onWithdraw: (itemId: string) => void act('withdraw', itemId),
    onResume: () => void act('resume'),
  };
}
