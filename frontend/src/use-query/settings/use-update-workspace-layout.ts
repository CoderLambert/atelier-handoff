/**
 * @file 提供读取和保存工作区布局的查询入口。
 * @implementation 串行保存布局并同步本地查询缓存。
 * @updated 2026-11-22T00:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceLayout } from '@shared/workspace-layout';
import { api } from '@/api/client';
import { workspaceLayoutKey } from './use-workspace-layout';

export function useUpdateWorkspaceLayout() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...workspaceLayoutKey, 'update'],
    scope: { id: 'workspace-layout' },
    mutationFn: (layout: WorkspaceLayout) =>
      api<WorkspaceLayout>('/api/settings/workspace-layout', { method: 'PATCH', body: layout }),
    onSuccess: (layout) => client.setQueryData(workspaceLayoutKey, layout),
  });
}
