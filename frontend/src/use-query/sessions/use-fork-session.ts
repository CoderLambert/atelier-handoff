/**
 * @file 从指定消息创建独立会话。
 * @implementation 使用稳定的请求标识提交分支操作，成功后失效引导与会话列表缓存并返回分支会话。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Session } from '@shared/types';
import { api } from '@/api/client';

export interface ForkSessionInput {
  sessionId: string;
  messageId: string;
  idempotencyKey: string;
  rewindFromHead?: string;
}

export function useForkSession() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['sessions', 'fork'],
    mutationFn: ({ sessionId, ...body }: ForkSessionInput) =>
      api<{ session: Session }>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: 'POST',
        body,
      }),
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
      void client.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}
