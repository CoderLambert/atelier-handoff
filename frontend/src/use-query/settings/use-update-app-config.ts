/**
 * @file 保存应用配置及任务执行限制。
 * @implementation 通过独立 mutation 提交配置，成功后更新配置快照并使启动信息失效。
 * @updated 2026-11-20T15:07:56+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AppConfig } from '@shared/types';
import { api } from '@/api/client';
import type { ConfigInfo } from '@/api/types';
import { settingsKeys } from './keys';

export function useUpdateAppConfig() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: settingsKeys.updateConfig,
    retry: false,
    mutationFn: (config: AppConfig) =>
      api<ConfigInfo>('/api/config', { method: 'PATCH', body: config }),
    onSuccess: (data) => {
      client.setQueryData(settingsKeys.config, data);
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
}
