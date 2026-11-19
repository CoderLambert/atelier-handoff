/**
 * @file 读取项目中的指定文本文件。
 * @implementation 按项目和路径查询文件内容，路径为空时跳过请求。
 * @updated 2026-11-20T02:00+08:00
 */
import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { projectKeys } from './keys';

export function useProjectFile(projectId: string, path: string | null) {
  return useQuery({
    queryKey: projectKeys.file(projectId, path),
    queryFn:
      path === null
        ? skipToken
        : ({ signal }) =>
            api<{ path: string; text: string }>(
              `/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`,
              { signal },
            ),
  });
}
