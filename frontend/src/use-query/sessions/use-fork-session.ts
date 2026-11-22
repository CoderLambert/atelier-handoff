/**
 * @file 从指定消息创建独立会话。
 * @implementation 使用稳定的请求标识提交分支操作，返回分支会话供工作区选择。
 * @updated 2026-11-21T00:00:00Z
 */
import { useMutation } from '@tanstack/react-query';
import type { Session } from '@shared/types';
import { api } from '@/api/client';

export interface ForkSessionInput {
  sessionId: string;
  messageId: string;
  idempotencyKey: string;
  rewindFromHead?: string;
}

export function useForkSession() {
  return useMutation({
    mutationKey: ['sessions', 'fork'],
    mutationFn: ({ sessionId, ...body }: ForkSessionInput) =>
      api<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: 'POST',
        body,
      }),
    retry: false,
  });
}
