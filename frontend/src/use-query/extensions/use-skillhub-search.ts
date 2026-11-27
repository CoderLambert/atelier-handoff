/**
 * @file 搜索公开 SkillHub 市场目录。
 * @implementation 按项目与查询关键词缓存搜索结果，支持手动重新拉取。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { endpoint, extensionKeys } from './keys';

export interface SkillHubItem {
  source: string;
  coordinate: string;
  title: string;
  version: string;
  description: string;
  publisher?: string;
  category?: string;
}

export function useSkillHubSearch(projectId: string, query: string) {
  return useQuery({
    queryKey: extensionKeys.skillHubSearch(projectId, query),
    queryFn: ({ signal }) =>
      api<{ items: SkillHubItem[] }>(
        `${endpoint(projectId, 'skillhub-search')}?q=${encodeURIComponent(query)}`,
        { signal },
      ),
  });
}
