/**
 * @file 提供更新或启停定时任务的 TanStack Mutation hook。
 * @implementation 提交带乐观并发版本号的局部更新并在成功后失效 schedules 缓存。
 * @updated 2026-11-27T13:34:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScheduledTask, UpdateScheduledTaskInput } from '@shared/types';
import { api } from '@/api/client';
import { scheduleDetailEndpoint, scheduleKeys } from './keys';

export function useUpdateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateScheduledTaskInput }) => {
      const result = await api<{ task: ScheduledTask }>(scheduleDetailEndpoint(id), {
        method: 'PATCH',
        body: patch,
      });
      return result.task;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: scheduleKeys.all });
    },
  });
}
