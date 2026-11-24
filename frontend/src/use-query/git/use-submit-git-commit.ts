/**
 * @file 提交已核对的 Git 暂存区。
 * @implementation 发送用户编辑的提交信息和暂存版本，成功后刷新工作树及分支状态。
 * @updated 2026-11-24T04:36:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { gitCommitReceipt, type GitCommitRequest } from '@shared/git-workbench';
import { gitKeys, gitTreeUrl } from './keys';

export function useSubmitGitCommit(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: GitCommitRequest) =>
      gitCommitReceipt.parse(
        await api(gitTreeUrl(projectId, treeId) + '/commit', { method: 'POST', body }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: gitKeys.overview(projectId) });
      void client.invalidateQueries({ queryKey: gitKeys.files(projectId, treeId) });
      void client.invalidateQueries({ queryKey: gitKeys.diffs(projectId, treeId) });
    },
  });
}
