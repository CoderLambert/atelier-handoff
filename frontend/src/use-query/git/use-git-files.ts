/**
 * @file 查询所选工作树的文件状态。
 * @implementation 从运行时读取暂存、未暂存、未跟踪、冲突和忽略状态。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitFileStatus } from '@shared/git-workbench';
import { gitKeys, gitTreeUrl } from './keys';

export function useGitFiles(projectId: string, treeId?: string) {
  return useQuery({
    queryKey: gitKeys.files(projectId, treeId),
    queryFn: treeId
      ? ({ signal }) => api<GitFileStatus>(gitTreeUrl(projectId, treeId) + '/status', { signal })
      : skipToken,
    retry: false,
  });
}
