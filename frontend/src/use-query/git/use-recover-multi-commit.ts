/**
 * @file 恢复所选工作树中已中断的多提交操作。
 * @implementation 仅发送操作编号，服务端依据已保存证据核对引用和索引后处理。
 * @updated 2026-11-24T14:41:22+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { multiCommitReceipt } from '@shared/git-multi-commit';
import { gitKeys, gitTreeUrl } from './keys';
import { pendingMultiCommitKey } from './use-pending-multi-commits';

export function useRecoverMultiCommit(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (operationId: string) =>
      multiCommitReceipt.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit-plan-recover', {
          method: 'POST',
          body: { operationId },
        }),
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: pendingMultiCommitKey(projectId, treeId) });
      void client.invalidateQueries({ queryKey: gitKeys.overview(projectId) });
      void client.invalidateQueries({ queryKey: gitKeys.files(projectId, treeId) });
      void client.invalidateQueries({ queryKey: gitKeys.diffs(projectId, treeId) });
    },
  });
}
