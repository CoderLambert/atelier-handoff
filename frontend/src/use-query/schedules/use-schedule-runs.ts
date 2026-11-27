/**
 * @file 查询单个定时任务的运行历史记录。
 * @implementation 按 taskId 懒加载最近触发记录，支持按需刷新。
 * @updated 2026-11-27T13:26:00+08:00
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ScheduledTaskRun } from '@shared/types';
import { api } from '@/api/client';
import { scheduleKeys, scheduleRunsEndpoint } from './keys';

export const scheduleRunsQuery = (taskId?: string, limit = 50) =>
  queryOptions({
    queryKey: scheduleKeys.runs(taskId ?? ''),
    enabled: Boolean(taskId),
    queryFn: async ({ signal }) => {
      if (!taskId) return [];
      const result = await api<{ items: ScheduledTaskRun[] }>(scheduleRunsEndpoint(taskId, limit), {
        signal,
      });
      return result.items;
    },
  });

export function useScheduleRuns(taskId?: string, limit = 50) {
  return useQuery(scheduleRunsQuery(taskId, limit));
}
