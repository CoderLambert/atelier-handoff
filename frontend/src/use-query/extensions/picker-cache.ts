/**
 * @file 提供聊天 picker 的共享扩展缓存助手。
 * @implementation 仅从有效缓存读取跨项目 MCP，并先取消旧请求再刷新 picker 缓存。
 * @updated 2026-11-27T00:00:00+08:00
 */
import { useQueryClient, type QueryClient, type QueryState } from '@tanstack/react-query';
import type { Extension } from '@shared/types';
import { extensionPickerKeys } from './keys';

export function pickerCatalogItems(
  projectId: string | undefined,
  items: readonly Extension[] | undefined,
  state: Pick<QueryState, 'status' | 'isInvalidated'> | undefined,
) {
  const sharedCurrent = state?.status === 'success' && !state.isInvalidated;
  return (items ?? []).filter(
    (item) =>
      item.projectId === projectId ||
      (sharedCurrent && item.kind === 'mcp' && item.transport.type === 'stdio'),
  );
}

export async function invalidateExtensionPickers(client: QueryClient) {
  const filters = { queryKey: extensionPickerKeys.all };
  // Even a first load with no cached data may carry a snapshot from before the change.
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}

export function useInvalidateExtensionPickers() {
  const client = useQueryClient();
  return () => invalidateExtensionPickers(client);
}
