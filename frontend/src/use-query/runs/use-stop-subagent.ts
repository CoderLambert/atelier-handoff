/**
 * @file 提供运行内单个子任务的停止操作。
 * @implementation 校验停止回执，成功后刷新所属会话和运行轨迹，失败保留界面供重试。
 * @updated 2026-11-22T16:00:00+08:00
 */
import {
  mutationOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { z } from 'zod';
import type { Run } from '@shared/types';
import { api } from '@/api/client';
import { sessionKeys } from '@/use-query/sessions/keys';
import { runKeys } from './keys';

export function stopSubagentOptions(run: Pick<Run, 'id' | 'sessionId'>, client: QueryClient) {
  return mutationOptions({
    mutationKey: runKeys.stopSubagent(run.id),
    mutationFn: async (subagentId: string) =>
      z.object({ ok: z.literal(true) }).parse(
        await api<unknown>(
          `/api/runs/${encodeURIComponent(run.id)}/subagents/${encodeURIComponent(subagentId)}/stop`,
          {
            method: 'POST',
            body: {},
          },
        ),
      ),
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: sessionKeys.snapshot(run.sessionId), exact: true }),
        client.invalidateQueries({ queryKey: runKeys.trace(run.id), exact: true }),
      ]);
    },
  });
}

export function useStopSubagent(run: Pick<Run, 'id' | 'sessionId'>) {
  return useMutation(stopSubagentOptions(run, useQueryClient()));
}
