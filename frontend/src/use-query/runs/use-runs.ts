import { queryOptions, skipToken, useQuery } from '@tanstack/react-query';
import type { Run } from '@shared/types';
import { api } from '@/api/client';
import type { Page } from '@/api/types';
import { runKeys, type RunListFilters } from './keys';

export const runsQuery = (filters: RunListFilters | undefined) =>
  queryOptions({
    queryKey: runKeys.list(filters),
    queryFn: !filters
      ? skipToken
      : ({ signal }) => {
          const query = new URLSearchParams({
            limit: String(filters.limit),
            offset: String(filters.offset),
          });
          if (filters.projectId) query.set('projectId', filters.projectId);
          if (filters.sessionId) query.set('sessionId', filters.sessionId);
          if (filters.status) query.set('status', filters.status);
          return api<Page<Run>>(`/api/runs?${query}`, { signal });
        },
    retry: false,
    staleTime: 0,
  });

export function useRuns(filters: RunListFilters | undefined) {
  return useQuery(runsQuery(filters));
}
