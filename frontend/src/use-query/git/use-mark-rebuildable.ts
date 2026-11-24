/**
 * @file 保存可重建忽略路径的选择。
 * @implementation 逐路径更改关联工作树的回收记录，刷新该目录的状态。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { gitKeys, gitTreeUrl } from './keys';

export function useMarkRebuildable(projectId: string, treeId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { path: string; rebuildable: boolean }) =>
      api<{ rebuildable: string[] }>(gitTreeUrl(projectId, treeId) + '/cache', {
        method: 'POST',
        body,
      }),
    onSuccess: (saved) => {
      client.setQueryData(
        gitKeys.files(projectId, treeId),
        (previous: import('@shared/git-workbench').GitFileStatus | undefined) =>
          previous && { ...previous, rebuildable: saved.rebuildable },
      );
    },
  });
}
