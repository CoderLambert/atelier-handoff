/**
 * @file 提供运行停止请求及其待处理状态。
 * @implementation 按运行和会话识别待处理请求；收到停止中回执后更新仍活跃的会话快照，请求结束后刷新相关缓存。
 * @updated 2026-11-27T14:21:24+08:00
 */
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { activeStatuses, type Run } from '@shared/types';
import { api } from '@/api/client';
import type { Snapshot } from '@/api/types';
import { sessionKeys } from '@/use-query/sessions/keys';
import { runKeys } from './keys';

const stopMutationKey = ['runs', 'stop'] as const;
type StopTarget = Pick<Run, 'id' | 'sessionId'>;

export function useRunStopPending(run: StopTarget | undefined) {
  return useIsMutating({
    mutationKey: stopMutationKey,
    exact: true,
    predicate: ({ state: { variables } }) =>
      run !== undefined &&
      typeof variables === 'object' && variables !== null &&
      'id' in variables && variables.id === run.id &&
      'sessionId' in variables && variables.sessionId === run.sessionId,
  }) > 0;
}

export function useStopRun() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: stopMutationKey,
    mutationFn: (run: StopTarget) =>
      api<{ run: Run }>(`/api/runs/${encodeURIComponent(run.id)}/stop`, {
        method: 'POST',
        body: {},
      }),
    retry: false,
    onSuccess: async ({ run }, target) => {
      if (run.status !== 'stopping') return;
      const queryKey = sessionKeys.snapshot(target.sessionId);
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData<Snapshot>(queryKey, (snapshot) => {
        if (!snapshot?.runs.some((current) => current.id === run.id && activeStatuses.includes(current.status)))
          return snapshot;
        return {
          ...snapshot,
          runs: snapshot.runs.map((current) =>
            current.id === run.id ? { ...current, status: 'stopping' } : current,
          ),
        };
      });
    },
    onSettled: (_, _error, run) => {
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: runKeys.trace(run.id) });
      void client.invalidateQueries({ queryKey: sessionKeys.snapshot(run.sessionId), exact: true });
    },
  });
}
