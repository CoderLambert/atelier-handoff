import { queryOptions, skipToken, useQuery } from '@tanstack/react-query';
import type { Artifact } from '@shared/types';
import { api } from '@/api/client';
import type { Page } from '@/api/types';
import { artifactKeys, type ArtifactListFilters } from './keys';

export const artifactsQuery = (filters: ArtifactListFilters | undefined) =>
  queryOptions({
    queryKey: artifactKeys.list(filters),
    queryFn: !filters
      ? skipToken
      : ({ signal }) => {
          const query = new URLSearchParams({
            limit: String(filters.limit),
            offset: String(filters.offset),
          });
          if (filters.projectId) query.set('projectId', filters.projectId);
          if (filters.sessionId) query.set('sessionId', filters.sessionId);
          return api<Page<Artifact>>(`/api/artifacts?${query}`, { signal });
        },
    retry: false,
    staleTime: 0,
  });

export function useArtifacts(filters: ArtifactListFilters | undefined) {
  return useQuery(artifactsQuery(filters));
}
