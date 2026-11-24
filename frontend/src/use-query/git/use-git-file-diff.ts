/**
 * @file 查询单个 Git 文件及其变动层的差异。
 * @implementation 用文件路径、索引层和工作树身份隔离结果。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitDiff, GitDiffLayer } from '@shared/git-workbench';
import { gitKeys, gitTreeUrl } from './keys';

export function useGitFileDiff(
  projectId: string,
  treeId?: string,
  file?: { path: string; layer: GitDiffLayer },
) {
  return useQuery({
    queryKey: gitKeys.diff(projectId, treeId, file?.path, file?.layer),
    queryFn:
      treeId && file
        ? ({ signal }) =>
            api<GitDiff>(gitTreeUrl(projectId, treeId) + '/diff?' + new URLSearchParams(file), {
              signal,
            })
        : skipToken,
    retry: false,
  });
}
