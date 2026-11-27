/**
 * @file 提供扩展目录的修改操作。
 * @implementation 按项目串行修改扩展及更新目录缓存，操作结束后同时刷新 picker 缓存。
 * @updated 2026-11-27T00:00:00+08:00
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Extension } from '@shared/types';
import { api } from '@/api/client';
import { endpoint, extensionKeys } from './keys';
import { invalidateExtensionPickers } from './picker-cache';

export type ItemResponse = { item?: Extension; extension?: Extension } | Extension | undefined;

export function returnedItem(result: ItemResponse) {
  if (!result) return undefined;
  if ('id' in result) return result;
  return result.item ?? result.extension;
}

interface ExtensionOperation {
  suffix?: string;
  method: 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  removeId?: string;
}

// Hook-level callbacks finish even when the dialog that started a request unmounts.
// Every operation carries its own project key; late responses cannot update another project.
export function useExtensionMutation<T = ItemResponse>(projectId: string) {
  const client = useQueryClient();
  return useMutation(extensionMutationOptions<T>(client, projectId));
}

export function extensionMutationOptions<T = ItemResponse>(client: QueryClient, projectId: string) {
  return {
    mutationKey: extensionKeys.mutations(projectId),
    scope: { id: `extensions:${projectId}` },
    mutationFn: (operation: ExtensionOperation) =>
      api<T>(endpoint(projectId, operation.suffix), {
        method: operation.method,
        body: operation.body,
      }),
    onMutate: async () => {
      await client.cancelQueries({ queryKey: extensionKeys.list(projectId) });
    },
    onSuccess: (result: T, operation: ExtensionOperation) => {
      const item = returnedItem(result as ItemResponse);
      if (item)
        client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) => {
          if (!items) return [item];
          return items.some((old) => old.id === item.id)
            ? items.map((old) => (old.id === item.id ? item : old))
            : [...items, item];
        });
      if (operation.removeId)
        client.setQueryData<Extension[]>(extensionKeys.list(projectId), (items) =>
          items?.filter((old) => old.id !== operation.removeId),
        );
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: extensionKeys.list(projectId) }),
        invalidateExtensionPickers(client),
      ]),
  };
}
