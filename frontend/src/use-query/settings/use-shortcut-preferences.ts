/**
 * @file 读取工作台快捷设置。
 * @implementation 通过独立查询键共享持久化的快捷配置，并在响应边界校验数据。
 * @updated 2026-11-26T13:40:00Z
 */
import { useQuery } from '@tanstack/react-query';
import { shortcutPreferencesSchema } from '@shared/shortcuts';
import { api } from '@/api/client';
import { settingsKeys } from './keys';

export function useShortcutPreferences() {
  return useQuery({
    queryKey: settingsKeys.shortcuts,
    queryFn: async ({ signal }) =>
      shortcutPreferencesSchema.parse(await api('/api/settings/shortcuts', { signal })),
    staleTime: Infinity,
    retry: false,
  });
}
