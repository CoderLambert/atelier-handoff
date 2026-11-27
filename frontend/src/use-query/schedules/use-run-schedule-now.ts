/**
 * @file 提供手动立即触发定时任务的 TanStack Mutation hook。
 * @implementation 触发一次不影响下次计划时刻的运行并刷新任务与历史记录缓存。
 * @updated 2026-11-27T13:34:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduledTaskRun } from '@shared/types';
import { api } from '@/api/client';
import { scheduleKeys, scheduleRunNowEndpoint } from './keys';

export function useRunScheduleNow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await api<{ run: ScheduledTaskRun }>(scheduleRunNowEndpoint(id), {
        method: 'POST',
      });
      return result.run;
    },
    onSuccess: (_run, id) => {
      void client.invalidateQueries({ queryKey: scheduleKeys.all });
      void client.invalidateQueries({ queryKey: scheduleKeys.runs(id) });
    },
  });
}
