/**
 * @file 提供创建定时任务的 TanStack Mutation hook。
 * @implementation 提交创建请求并在成功后失效 schedules 查询域缓存。
 * @updated 2026-11-27T13:34:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateScheduledTaskInput, ScheduledTask } from '@shared/types';
import { api } from '@/api/client';
import { scheduleKeys, scheduleListEndpoint } from './keys';

export function useCreateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateScheduledTaskInput) => {
      const result = await api<{ task: ScheduledTask }>(scheduleListEndpoint(), {
        method: 'POST',
        body: input,
      });
      return result.task;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: scheduleKeys.all });
    },
  });
}
