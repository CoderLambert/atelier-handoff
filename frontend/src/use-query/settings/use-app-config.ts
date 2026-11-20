/**
 * @file 查询当前应用配置及本机网关状态。
 * @implementation 通过可取消的配置查询读取快照，关闭设置后释放缓存，查询失败由界面提供重试。
 * @updated 2026-11-20T15:07:56+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { ConfigInfo } from '@/api/types';
import { settingsKeys } from './keys';

export function useAppConfig() {
  return useQuery({
    queryKey: settingsKeys.config,
    queryFn: ({ signal }) => api<ConfigInfo>('/api/config', { signal }),
    refetchOnWindowFocus: false,
    retry: false,
    gcTime: 0,
  });
}
