/**
 * @file 根据关键词检索工作目录文件。
 * @implementation 按项目及可选会话查询匹配结果，用于输入区的 @ 引用。
 * @updated 2026-11-24T03:39:03+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { projectKeys } from './keys';

export interface ProjectFileList {
  path: string;
  items: { name: string; path: string; isDirectory: boolean; size: number }[];
}

export function useSearchProjectFiles(
  projectId: string | undefined,
  query: string,
  enabled = true,
  sessionId?: string,
) {
  return useQuery({
    queryKey: projectKeys.searchFiles(projectId ?? '', query, sessionId),
    queryFn: ({ signal }) =>
      api<ProjectFileList>(
        `/api/projects/${encodeURIComponent(projectId ?? '')}/files?${new URLSearchParams({ query, ...(sessionId ? { sessionId } : {}) })}`,
        { signal },
      ),
    enabled: Boolean(projectId) && enabled,
    staleTime: 5000,
  });
}
