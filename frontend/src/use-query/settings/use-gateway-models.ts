/**
 * @file 按需读取当前配置对应的模型目录。
 * @implementation 按网关、Magpie 开关和配置快照区分可取消的查询，校验目录结构，并提供刷新和已保存的接入状态。
 * @updated 2026-11-22T13:47:04+08:00
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { gatewayModelCatalogSchema, type GatewayModelCatalog } from '@shared/types';
import { api, ApiError } from '@/api/client';
import { settingsKeys } from './keys';
import { useAppConfig } from './use-app-config';

async function requestCatalog(signal: AbortSignal, refresh = false): Promise<GatewayModelCatalog> {
  const result = gatewayModelCatalogSchema.safeParse(
    await api<unknown>(refresh ? '/api/models?refresh=1' : '/api/models', { signal }),
  );
  if (!result.success) throw new ApiError('INVALID_MODEL_CATALOG', 502, 'INVALID_MODEL_CATALOG');
  return result.data;
}

export function useGatewayModels(enabled = false) {
  const client = useQueryClient();
  const config = useAppConfig();
  // A configuration save or login creates a new snapshot even when its visible URL is unchanged.
  // Old responses then belong to their old key and cannot populate the new source's picker.
  const queryKey = [
    ...settingsKeys.models,
    config.data?.config.gateway,
    config.data?.config.managedGateway,
    config.data?.config.magpieEnabled,
    config.data?.config.model,
    config.dataUpdatedAt,
  ] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => requestCatalog(signal),
    enabled: enabled && config.isSuccess,
    retry: false,
    staleTime: 0,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  return {
    ...query,
    magpieEnabled: config.data?.config.magpieEnabled === true,
    isFetching: query.isFetching || (enabled && config.isFetching),
    isError: query.isError || config.isError,
    error: query.error ?? config.error,
    async refresh() {
      if (!config.isSuccess) return config.refetch();
      await client.cancelQueries({ queryKey, exact: true });
      return client
        .fetchQuery({
          queryKey,
          queryFn: ({ signal }) => requestCatalog(signal, true),
          retry: false,
          staleTime: 0,
          gcTime: 5 * 60 * 1000,
        })
        .catch(() => undefined);
    },
  };
}
