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
