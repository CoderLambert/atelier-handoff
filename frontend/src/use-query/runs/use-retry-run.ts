/**
 * @file 提供运行重试操作。
 * @implementation 发送带幂等键的重试请求，成功后使会话、运行列表和轨迹缓存失效。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Run } from '@shared/types';
import { api } from '@/api/client';
import { sessionKeys } from '@/use-query/sessions/keys';
import { runKeys } from './keys';

export function useRetryRun(run: Pick<Run, 'id' | 'sessionId'>) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: runKeys.retry(run.id),
    mutationFn: (idempotencyKey: string) =>
      api<{ run: Run }>(`/api/runs/${encodeURIComponent(run.id)}/retry`, {
        method: 'POST',
        body: { idempotencyKey },
      }),
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: sessionKeys.snapshot(run.sessionId) });
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: runKeys.trace(run.id) });
    },
  });
}
