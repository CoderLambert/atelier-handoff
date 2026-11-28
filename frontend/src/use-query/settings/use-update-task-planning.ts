/**
 * @file 保存全局任务规划设置或单模型覆盖。
 * @implementation 校验写入回执并精确更新设置缓存。
 * @updated 2026-11-28T21:12:24+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { taskPlanningSettingsSchema, type TaskPlanningPatch } from '@shared/task-planning';
import { api } from '@/api/client';
import { settingsKeys } from './keys';

export function useUpdateTaskPlanning() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...settingsKeys.taskPlanning, 'update'],
    retry: false,
    mutationFn: async (patch: TaskPlanningPatch) =>
      taskPlanningSettingsSchema.parse(
        await api<unknown>('/api/settings/task-planning', { method: 'PATCH', body: patch }),
      ),
    onSuccess: async (saved) => {
      await client.cancelQueries({ queryKey: settingsKeys.taskPlanning, exact: true });
      client.setQueryData(settingsKeys.taskPlanning, saved);
    },
  });
}
