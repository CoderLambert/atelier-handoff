/**
 * @file 保存工作台快捷设置。
 * @implementation 串行更新快捷配置，保存成功后同步监听器使用的查询缓存。
 * @updated 2026-11-26T13:40:00Z
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { shortcutPreferencesSchema, type ShortcutPreferences } from '@shared/shortcuts';
import { api } from '@/api/client';
import { settingsKeys } from './keys';

export function useUpdateShortcutPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: [...settingsKeys.shortcuts, 'update'],
    scope: { id: 'shortcut-preferences' },
    mutationFn: async (preferences: ShortcutPreferences) =>
      shortcutPreferencesSchema.parse(
        await api('/api/settings/shortcuts', { method: 'PATCH', body: preferences }),
      ),
    onSuccess: async (preferences) => {
      await client.cancelQueries({ queryKey: settingsKeys.shortcuts, exact: true });
      client.setQueryData(settingsKeys.shortcuts, preferences);
    },
  });
}
