/**
 * @file 获取工作目录的文件列表。
 * @implementation 按项目、可选会话和目录路径查询文件与目录元数据。
 * @updated 2026-11-24T03:39:03+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { projectKeys } from './keys';

interface ProjectFileList {
  path: string;
  items: { name: string; path: string; isDirectory: boolean; size: number }[];
}

export function useProjectFiles(projectId: string, directory: string, sessionId?: string) {
  return useQuery({
    queryKey: projectKeys.files(projectId, directory, sessionId),
    queryFn: ({ signal }) =>
      api<ProjectFileList>(
        `/api/projects/${encodeURIComponent(projectId)}/files?${new URLSearchParams({ path: directory, ...(sessionId ? { sessionId } : {}) })}`,
        { signal },
      ),
  });
}
