/**
 * @file 修改项目内置桌面浏览器工具授权。
 * @implementation 提交启用状态与已核对的授权版本，只更新发起项目的缓存，失败后重新核对权威状态。
 * @updated 2026-11-20T11:57:56+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  desktopBrowserAccessStateSchema,
  desktopBrowserAccessUpdateSchema,
  type DesktopBrowserAccessUpdate,
} from '@shared/desktop-browser';
import { api } from '@/api/client';
import { browserKeys } from './keys';

export type UpdateDesktopBrowserAccess = DesktopBrowserAccessUpdate & { projectId: string };

export async function updateDesktopBrowserAccess({
  projectId,
  enabled,
  revision,
}: UpdateDesktopBrowserAccess) {
  return desktopBrowserAccessStateSchema.parse(
    await api<unknown>(`/api/projects/${encodeURIComponent(projectId)}/desktop-browser`, {
      method: 'PATCH',
      body: desktopBrowserAccessUpdateSchema.parse({ enabled, revision }),
    }),
  );
}

export function useUpdateDesktopBrowserAccess() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: browserKeys.updateDesktopAccess,
    retry: false,
    mutationFn: updateDesktopBrowserAccess,
    onMutate: ({ projectId }) =>
      client.cancelQueries({ queryKey: browserKeys.desktopAccess(projectId), exact: true }),
    onSuccess: (data, { projectId }) => {
      client.setQueryData(browserKeys.desktopAccess(projectId), data);
    },
    onSettled: (_data, _error, { projectId }) =>
      client.invalidateQueries({ queryKey: browserKeys.desktopAccess(projectId), exact: true }),
  });
}
