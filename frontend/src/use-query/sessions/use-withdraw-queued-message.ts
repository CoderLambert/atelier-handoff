/**
 * @file 提供撤回会话待处理消息的操作。
 * @implementation 按会话和条目标识发送删除请求，无论成功或冲突均刷新发起会话快照，保留服务端队列为唯一状态源。
 * @updated 2026-11-20T23:09:03+08:00
 */
import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/api/client';
import { sessionKeys } from './keys';

export interface WithdrawQueuedMessageInput {
  sessionId: string;
  itemId: string;
}
const resultSchema = z.object({ ok: z.literal(true) });
export type WithdrawQueuedMessageResult = z.infer<typeof resultSchema>;

export async function withdrawQueuedMessage({ sessionId, itemId }: WithdrawQueuedMessageInput) {
  return resultSchema.parse(
    await api<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/message-queue/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    ),
  );
}

export function withdrawQueuedMessageOptions(client: QueryClient, sessionId: string) {
  return mutationOptions({
    mutationKey: sessionKeys.withdrawMessage(sessionId),
    mutationFn: (itemId: string) => withdrawQueuedMessage({ sessionId, itemId }),
    retry: false,
    onSettled: () =>
      client.invalidateQueries({ queryKey: sessionKeys.snapshot(sessionId), exact: true }),
  });
}

export function useWithdrawQueuedMessage(sessionId: string) {
  const client = useQueryClient();
  return useMutation(withdrawQueuedMessageOptions(client, sessionId));
}
