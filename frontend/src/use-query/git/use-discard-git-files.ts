/**
 * @file 丢弃当前工作树中已确认的文件变更。
 * @implementation 通过项目 API 更新指定层，操作结束后刷新状态和本工作树的差异。
 * @updated 2026-11-25T16:31:33+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { gitFileIndexReceipt, type GitFileDiscardRequest } from '@shared/git-workbench';
import { gitKeys, gitTreeUrl } from './keys';

export function useDiscardGitFiles(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: GitFileDiscardRequest) =>
      gitFileIndexReceipt.parse(
        await api(gitTreeUrl(projectId, treeId) + '/file-discard', { method: 'POST', body }),
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: gitKeys.files(projectId, treeId) }),
        client.invalidateQueries({ queryKey: gitKeys.diffs(projectId, treeId) }),
      ]);
    },
  });
}
