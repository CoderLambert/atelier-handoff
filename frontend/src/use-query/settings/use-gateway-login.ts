/**
 * @file 发起内置 Shunt 的 ChatGPT 登录。
 * @implementation 等待宿主登录命令完成后更新配置与账户文件状态，并刷新模型目录和启动信息。
 * @updated 2026-11-20T19:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { ConfigInfo } from '@/api/types';
import { settingsKeys } from './keys';

export function useGatewayLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationKey: settingsKeys.gatewayLogin,
    retry: false,
    mutationFn: () => api<ConfigInfo>('/api/config/gateway-login', { method: 'POST', body: {} }),
    onSuccess: (data) => {
      client.setQueryData(settingsKeys.config, data);
      void client.invalidateQueries({ queryKey: settingsKeys.models });
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
    },
  });
}
