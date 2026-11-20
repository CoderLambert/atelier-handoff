/**
 * @file 查询项目内置桌面浏览器工具的可用性和授权。
 * @implementation 使用共享 schema 校验运行时快照，按项目隔离缓存并定期核对授权状态。
 * @updated 2026-11-20T11:57:56+08:00
 */
import { queryOptions, skipToken, useQuery } from '@tanstack/react-query';
import { desktopBrowserAccessStateSchema } from '@shared/desktop-browser';
import { api } from '@/api/client';
import { browserKeys } from './keys';

export const desktopBrowserAccessQuery = (projectId: string | undefined) =>
  queryOptions({
    queryKey: browserKeys.desktopAccess(projectId),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: 5000,
    queryFn: !projectId
      ? skipToken
      : async ({ signal }) =>
          desktopBrowserAccessStateSchema.parse(
            await api<unknown>(`/api/projects/${encodeURIComponent(projectId)}/desktop-browser`, {
              signal,
            }),
          ),
  });

export function useDesktopBrowserAccess(projectId: string | undefined) {
  return useQuery(desktopBrowserAccessQuery(projectId));
}
