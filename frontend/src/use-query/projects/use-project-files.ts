/**
 * @file 获取项目目录中的文件列表。
 * @implementation 按项目和目录路径查询文件及目录元数据。
 * @updated 2026-11-20T02:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { projectKeys } from './keys';

interface ProjectFileList {
  path: string;
  items: { name: string; path: string; isDirectory: boolean; size: number }[];
}

export function useProjectFiles(projectId: string, directory: string) {
  return useQuery({
    queryKey: projectKeys.files(projectId, directory),
    queryFn: ({ signal }) =>
      api<ProjectFileList>(
        `/api/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(directory)}`,
        { signal },
      ),
  });
}
