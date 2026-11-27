/**
 * @file 提供删除定时任务的 TanStack Mutation hook。
 * @implementation 调用删除接口并在成功后刷新定时任务列表缓存。
 * @updated 2026-11-27T13:34:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { scheduleDetailEndpoint, scheduleKeys } from './keys';

export function useDeleteSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api<{ deleted: true }>(scheduleDetailEndpoint(id), { method: 'DELETE' });
      return id;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: scheduleKeys.all });
    },
  });
}
