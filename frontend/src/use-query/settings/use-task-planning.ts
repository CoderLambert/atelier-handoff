/**
 * @file 查询工作台的任务规划设置。
 * @implementation 向设置 HTTP API 发起可取消查询，并用共享 schema 校验响应。
 * @updated 2026-11-28T21:32:37+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { taskPlanningSettingsSchema } from '@shared/task-planning';
import { api } from '@/api/client';
import { settingsKeys } from './keys';

export function useTaskPlanning() {
  return useQuery({
    queryKey: settingsKeys.taskPlanning,
    queryFn: async ({ signal }) =>
      taskPlanningSettingsSchema.parse(
        await api<unknown>('/api/settings/task-planning', { signal }),
      ),
    retry: false,
    refetchOnWindowFocus: false,
  });
}
