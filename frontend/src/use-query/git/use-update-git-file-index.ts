/**
 * @file 暂存或取消暂存所选工作树的文件。
 * @implementation 通过项目 API 修改索引并重新读取文件列表与差异。
 * @updated 2026-11-25T13:32:26+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { gitFileIndexReceipt, type GitFileIndexRequest } from '@shared/git-workbench';
import { gitKeys, gitTreeUrl } from './keys';

export function useUpdateGitFileIndex(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body: GitFileIndexRequest) =>
      gitFileIndexReceipt.parse(
        await api(gitTreeUrl(projectId, treeId) + '/file-index', { method: 'POST', body }),
      ),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: gitKeys.files(projectId, treeId) }),
        client.invalidateQueries({ queryKey: gitKeys.diffs(projectId, treeId) }),
      ]);
    },
  });
}
