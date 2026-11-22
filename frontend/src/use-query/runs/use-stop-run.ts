/**
 * @file 提供运行停止操作。
 * @implementation 发送停止请求，并在成功后使会话、运行列表和轨迹缓存失效。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Run } from '@shared/types';
import { api } from '@/api/client';
import { sessionKeys } from '@/use-query/sessions/keys';
import { runKeys } from './keys';

export function useStopRun() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: ['runs', 'stop'],
    mutationFn: (run: Pick<Run, 'id' | 'sessionId'>) =>
      api<{ run: Run }>(`/api/runs/${encodeURIComponent(run.id)}/stop`, {
        method: 'POST',
        body: {},
      }),
    retry: false,
    onSuccess: (_, run) => {
      void client.invalidateQueries({ queryKey: sessionKeys.snapshot(run.sessionId) });
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: runKeys.trace(run.id) });
    },
  });
}
