/**
 * @file 提供关闭并吊销单任务远程触发令牌的 TanStack Mutation hook。
 * @implementation 吊销后立即失效旧令牌并刷新定时任务列表缓存。
 * @updated 2026-11-27T15:25:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduledTask } from '@shared/types';
import { api } from '@/api/client';
import { scheduleKeys, scheduleTriggerTokenEndpoint } from './keys';

export function useRevokeScheduleTriggerToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await api<{ task: ScheduledTask }>(scheduleTriggerTokenEndpoint(id), {
        method: 'DELETE',
      });
      return result.task;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: scheduleKeys.all });
    },
  });
}
