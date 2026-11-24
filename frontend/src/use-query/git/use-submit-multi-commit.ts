/**
 * @file 提交用户核对后的多提交计划。
 * @implementation 传递快照版本和幂等编号，完成后刷新所选工作树的 Git 状态。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { multiCommitReceipt, type MultiCommitSubmit } from '@shared/git-multi-commit';
import { gitKeys, gitTreeUrl } from './keys';
import { pendingMultiCommitKey } from './use-pending-multi-commits';

export function useSubmitMultiCommit(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: MultiCommitSubmit) =>
      multiCommitReceipt.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-plan-execute', { method: 'POST', body }),
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: pendingMultiCommitKey(projectId, treeId) });
      void client.invalidateQueries({ queryKey: gitKeys.overview(projectId) });
      void client.invalidateQueries({ queryKey: gitKeys.files(projectId, treeId) });
      void client.invalidateQueries({ queryKey: gitKeys.diffs(projectId, treeId) });
    },
  });
}
