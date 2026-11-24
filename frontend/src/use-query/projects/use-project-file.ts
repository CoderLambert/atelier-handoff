/**
 * @file 读取工作目录中的文本文件。
 * @implementation 按项目、可选会话与路径查询文件，路径为空时跳过。
 * @updated 2026-11-24T03:39:03+08:00
 */
import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { projectKeys } from './keys';

export function useProjectFile(projectId: string, path: string | null, sessionId?: string) {
  return useQuery({
    queryKey: projectKeys.file(projectId, path, sessionId),
    queryFn:
      path === null
        ? skipToken
        : ({ signal }) =>
            api<{ path: string; text: string }>(
              `/api/projects/${encodeURIComponent(projectId)}/file?${new URLSearchParams({ path, ...(sessionId ? { sessionId } : {}) })}`,
              { signal },
            ),
  });
}
