/**
 * @file 更新 RTK 设置并刷新受影响的缓存。
 * @implementation 防止重复保存，以发起请求的项目身份写回回执，全局更新后刷新所有项目有效值。
 * @updated 2026-11-26T01:39:35+08:00
 */
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { rtkSettingsViewSchema, type RtkSettingsPatch } from '@shared/rtk-settings';
import { rtkSettingsEndpoint, rtkSettingsKeys } from './keys';

export function useUpdateRtkSettings(projectId?: string) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationKey: rtkSettingsKeys.update,
    retry: false,
    mutationFn: async ({ projectId, patch }: { projectId?: string; patch: RtkSettingsPatch }) =>
      rtkSettingsViewSchema.parse(
        await api(rtkSettingsEndpoint(projectId), { method: 'PATCH', body: patch }),
      ),
    onSuccess: async (view, { projectId, patch }) => {
      const queryKey = rtkSettingsKeys.view(projectId);
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, view);
      await client.invalidateQueries({
        queryKey: patch.type === 'global' ? rtkSettingsKeys.all : queryKey,
        exact: patch.type !== 'global',
      });
    },
  });
  const saving = useIsMutating({ mutationKey: rtkSettingsKeys.update }) > 0;
  return {
    saving,
    error: mutation.error,
    save: (patch: RtkSettingsPatch) => {
      if (!client.isMutating({ mutationKey: rtkSettingsKeys.update }))
        mutation.mutate({ projectId, patch });
    },
  };
}
