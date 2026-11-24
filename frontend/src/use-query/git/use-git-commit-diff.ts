/**
 * @file 查询本机提交的差异。
 * @implementation 将提交详情按项目及完整 SHA 缓存。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { skipToken, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitDiff } from '@shared/git-workbench';
import { gitKeys, gitUrl } from './keys';

export function useGitCommitDiff(projectId: string, oid?: string) {
  return useQuery({
    queryKey: gitKeys.commit(projectId, oid),
    queryFn: oid
      ? ({ signal }) =>
          api<GitDiff>(gitUrl(projectId) + '/commits/' + encodeURIComponent(oid), { signal })
      : skipToken,
    retry: false,
  });
}
