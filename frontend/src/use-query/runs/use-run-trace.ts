/**
 * @file 查询运行事件轨迹。
 * @implementation 按运行 ID 请求事件及总数，并将取消信号传给接口。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { RunEvent } from '@shared/types';
import { api } from '@/api/client';
import { runKeys } from './keys';

export interface RunTraceResponse {
  events: RunEvent[];
  eventCount: number;
}
export const runTraceQuery = (runId: string) =>
  queryOptions({
    queryKey: runKeys.trace(runId),
    queryFn: ({ signal }) =>
      api<RunTraceResponse>(`/api/runs/${encodeURIComponent(runId)}/trace`, { signal }),
    retry: false,
    staleTime: 0,
  });

export function useRunTrace(runId: string) {
  return useQuery(runTraceQuery(runId));
}
