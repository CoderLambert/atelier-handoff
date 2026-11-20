/**
 * @file 按需读取当前网关的模型目录。
 * @implementation 通过可取消的具名查询校验模型目录快照，弹窗打开时刷新，失败交由界面重试。
 * @updated 2026-11-20T16:40:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { GatewayModelCatalog } from '@shared/types';
import { api } from '@/api/client';
import { settingsKeys } from './keys';

const catalogSchema = z.object({
  defaultModel: z.string().min(1),
  routesAvailable: z.boolean(),
  models: z.array(
    z.object({
      id: z.string().min(1),
      displayName: z.string().optional(),
      provider: z.string().optional(),
      effort: z.string().optional(),
      serviceTier: z.string().optional(),
    }),
  ),
});

export function useGatewayModels(enabled: boolean) {
  return useQuery({
    queryKey: settingsKeys.models,
    queryFn: async ({ signal }): Promise<GatewayModelCatalog> => {
      const result = catalogSchema.safeParse(await api<unknown>('/api/models', { signal }));
      if (!result.success) throw new Error('模型列表格式不正确，请重新加载。');
      return result.data;
    },
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
}
