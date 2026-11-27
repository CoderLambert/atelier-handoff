/**
 * @file 查询项目的扩展目录和聊天 picker 目录。
 * @implementation 按 scope 使用独立缓存键，由服务端决定 picker 可见的跨项目扩展并暴露复合加载状态。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Extension } from '@shared/extensions';
import { api } from '@/api/client';
import { endpoint, extensionKeys, extensionPickerKeys } from './keys';
import { invalidateExtensionPickers, pickerCatalogItems } from './picker-cache';

type ExtensionCatalogScope = 'project' | 'picker';

export const extensionsQuery = (projectId: string, scope: ExtensionCatalogScope = 'project') =>
  queryOptions({
    queryKey:
      scope === 'picker' ? extensionPickerKeys.list(projectId) : extensionKeys.list(projectId),
    queryFn: async ({ signal }) => {
      const path = endpoint(projectId);
      const result = await api<{ items: Extension[] }>(
        scope === 'picker' ? `${path}?scope=picker` : path,
        { signal },
      );
      if (!Array.isArray(result?.items)) throw new Error('扩展列表响应缺少 items。');
      return result.items;
    },
    staleTime: 30_000,
    enabled: Boolean(projectId),
  });

export function useExtensions(projectId?: string, scope?: ExtensionCatalogScope) {
  return useQuery(extensionsQuery(projectId ?? '', scope));
}

export function useExtensionPickerCatalog(projectId?: string) {
  const query = useExtensions(projectId, 'picker');
  const client = useQueryClient();
  const catalog = client.getQueryState<Extension[]>(extensionPickerKeys.list(projectId ?? ''));
  const pickerLoading = query.isPending || (query.isFetching && Boolean(catalog?.isInvalidated));
  const items = pickerCatalogItems(projectId, query.data, catalog);
  return {
    query,
    pickerLoading,
    items,
    readCachedItems(id: string) {
      const cached = client.getQueryState<Extension[]>(extensionPickerKeys.list(id));
      return pickerCatalogItems(id, cached?.data, cached);
    },
    invalidate: () => invalidateExtensionPickers(client),
  };
}
