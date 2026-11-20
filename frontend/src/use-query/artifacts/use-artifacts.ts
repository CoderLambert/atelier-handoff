/**
 * @file 查询交付物分页列表。
 * @implementation 按项目、会话和分页条件构造可取消查询，未提供筛选条件时跳过请求。
 * @updated 2026-11-20T14:44:21+08:00
 */
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
