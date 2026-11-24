/**
 * @file 查询所选工作树中等待恢复的多提交操作。
 * @implementation 使用工作树身份隔离查询，并可通过刷新取得最新的持久状态。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { multiCommitPending } from '@shared/git-multi-commit';
import { gitTreeUrl } from './keys';

export const pendingMultiCommitKey = (projectId: string, treeId: string) =>
  ['git', projectId, 'worktree', treeId, 'pending-commit-plans'] as const;

export function usePendingMultiCommits(projectId: string, treeId: string, enabled = true) {
  return useQuery({
    queryKey: pendingMultiCommitKey(projectId, treeId),
    enabled,
    queryFn: async ({ signal }) =>
      multiCommitPending.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-plan-pending', { signal }),
      ),
  });
}
