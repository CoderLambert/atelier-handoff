/**
 * @file 查询工作台定时任务列表。
 * @implementation 支持全部项目或按指定项目过滤，封装标准化 TanStack Query hook。
 * @updated 2026-11-27T13:26:00+08:00
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ScheduledTask } from '@shared/types';
import { api } from '@/api/client';
import { scheduleKeys, scheduleListEndpoint } from './keys';

export const schedulesQuery = (projectId?: string) =>
  queryOptions({
    queryKey: scheduleKeys.list(projectId),
    queryFn: async ({ signal }) => {
      const result = await api<{ items: ScheduledTask[] }>(scheduleListEndpoint(projectId), {
        signal,
      });
      return result.items;
    },
  });

export function useSchedules(projectId?: string) {
  return useQuery(schedulesQuery(projectId));
}
