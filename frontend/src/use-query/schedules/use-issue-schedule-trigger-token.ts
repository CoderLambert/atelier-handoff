/**
 * @file 提供签发或轮换单任务远程触发令牌的 TanStack Mutation hook。
 * @implementation 签发或轮换后返回一次性明文令牌并刷新定时任务列表缓存。
 * @updated 2026-11-27T15:25:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduledTask } from '@shared/types';
import { api } from '@/api/client';
import { scheduleKeys, scheduleTriggerTokenEndpoint } from './keys';

export function useIssueScheduleTriggerToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      api<{ task: ScheduledTask; token: string }>(scheduleTriggerTokenEndpoint(id), {
        method: 'POST',
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: scheduleKeys.all });
    },
  });
}
