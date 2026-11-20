/**
 * @file 提供将待处理消息插入当前会话运行的操作。
 * @implementation 提交目标运行与插入模式，校验确认响应；不自动重试，并在成功或失败后只刷新发起会话的权威快照。
 * @updated 2026-11-21T00:15:48+08:00
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

export interface InsertQueuedMessageInput {
  sessionId: string;
  itemId: string;
  runId: string;
  mode: 'live' | 'priority';
}
export type InsertQueuedMessageVariables = Omit<InsertQueuedMessageInput, 'sessionId'>;
const resultSchema = z.object({ ok: z.literal(true) });
export type InsertQueuedMessageResult = z.infer<typeof resultSchema>;

export async function insertQueuedMessage({
  sessionId,
  itemId,
  runId,
  mode,
}: InsertQueuedMessageInput) {
  return resultSchema.parse(
    await api<unknown>(
      `/api/sessions/${encodeURIComponent(sessionId)}/message-queue/${encodeURIComponent(itemId)}/insert`,
      { method: 'POST', body: { runId, mode } },
    ),
  );
}

export function insertQueuedMessageOptions(client: QueryClient, sessionId: string) {
  return mutationOptions({
    mutationKey: [...sessionKeys.messageQueue(sessionId), 'insert'],
    mutationFn: (variables: InsertQueuedMessageVariables) =>
      insertQueuedMessage({ ...variables, sessionId }),
    retry: false,
    onSettled: () =>
      client.invalidateQueries({ queryKey: sessionKeys.snapshot(sessionId), exact: true }),
  });
}

export function useInsertQueuedMessage(sessionId: string) {
  const client = useQueryClient();
  return useMutation(insertQueuedMessageOptions(client, sessionId));
}
