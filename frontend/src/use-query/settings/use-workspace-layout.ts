/**
 * @file 提供读取和保存工作区布局的查询入口。
 * @implementation 串行保存布局并同步本地查询缓存。
 * @updated 2026-11-22T00:00:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import type { WorkspaceLayout } from '@shared/workspace-layout';
import { api } from '@/api/client';

export const workspaceLayoutKey = ['settings', 'workspace-layout'] as const;
export function useWorkspaceLayout() {
  return useQuery({
    queryKey: workspaceLayoutKey,
    queryFn: ({ signal }) => api<WorkspaceLayout>('/api/settings/workspace-layout', { signal }),
    staleTime: Infinity,
  });
}
