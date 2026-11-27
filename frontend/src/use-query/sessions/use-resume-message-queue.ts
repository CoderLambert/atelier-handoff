/**
 * @file 提供继续会话消息队列的操作。
 * @implementation 向指定会话提交可选的待复核消息 ID，并在成功或失败后重新同步该会话快照，不携带草稿或单次搜索授权。
 * @updated 2026-11-27T02:25:28+08:00
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

export interface ResumeMessageQueueInput {
  sessionId: string;
  reviewItemId?: string;
}
const resultSchema = z.object({ ok: z.literal(true) });
export type ResumeMessageQueueResult = z.infer<typeof resultSchema>;

export async function resumeMessageQueue({ sessionId, reviewItemId }: ResumeMessageQueueInput) {
  return resultSchema.parse(
    await api<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/message-queue/resume`, {
      method: 'POST',
      body: { reviewItemId },
    }),
  );
}

export function resumeMessageQueueOptions(client: QueryClient, sessionId: string) {
  return mutationOptions({
    mutationKey: sessionKeys.resumeQueue(sessionId),
    mutationFn: (reviewItemId?: string) => resumeMessageQueue({ sessionId, reviewItemId }),
    retry: false,
    onSettled: () =>
      client.invalidateQueries({ queryKey: sessionKeys.snapshot(sessionId), exact: true }),
  });
}

export function useResumeMessageQueue(sessionId: string) {
  const client = useQueryClient();
  return useMutation(resumeMessageQueueOptions(client, sessionId));
}
