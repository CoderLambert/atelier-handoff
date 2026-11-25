/**
 * @file 查询全局或项目 RTK 设置。
 * @implementation 将可取消请求及共享响应校验封装为 TanStack Query，并按项目隔离缓存。
 * @updated 2026-11-26T01:39:35+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { rtkSettingsViewSchema } from '@shared/rtk-settings';
import { rtkSettingsEndpoint, rtkSettingsKeys } from './keys';

export function useRtkSettings(projectId?: string) {
  return useQuery({
    queryKey: rtkSettingsKeys.view(projectId),
    queryFn: async ({ signal }) =>
      rtkSettingsViewSchema.parse(await api(rtkSettingsEndpoint(projectId), { signal })),
    retry: false,
  });
}
