/**
 * @file 重试回收已归档的工作树。
 * @implementation 提交持久请求编号并刷新对应项目的 Git 数据。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { GitSessionWorkspace } from '@shared/git-workbench';
import { gitKeys, gitTreeUrl } from './keys';

export function useReclaimWorktree(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) =>
      api<{ workspace: GitSessionWorkspace }>(gitTreeUrl(projectId, treeId) + '/reclaim', {
        method: 'POST',
        body: { requestId },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: gitKeys.project(projectId) });
    },
  });
}
