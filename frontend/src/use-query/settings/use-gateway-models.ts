/**
 * @file 按需读取当前网关的模型目录。
 * @implementation 默认禁用可取消的目录查询，打开选择器时校验模型与可选深度快照，失败交由界面重试。
 * @updated 2026-11-20T17:14:57+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { reasoningEfforts, type GatewayModelCatalog } from '@shared/types';
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
      supportedEfforts: z.array(z.enum(reasoningEfforts)).optional(),
      serviceTier: z.string().optional(),
    }),
  ),
});

export function useGatewayModels(enabled = false) {
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
