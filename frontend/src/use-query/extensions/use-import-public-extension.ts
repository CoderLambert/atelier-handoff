/**
 * @file 安装或更新项目的公开扩展。
 * @implementation 保存预览所选版本，写入项目扩展缓存并刷新会话技能可用性。
 * @updated 2026-11-26T12:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { PublicImportInput } from '@shared/public-extensions';
import type { Extension } from '@shared/types';
import { invalidateSkillCatalogs } from '@/use-query/skill-inheritance/keys';
import { endpoint, extensionKeys } from './keys';

export function useImportPublicExtension(projectId: string) {
  const client = useQueryClient();
  const list = extensionKeys.list(projectId);
  return useMutation({
    mutationKey: extensionKeys.mutations(projectId),
    scope: { id: `extensions:${projectId}` },
    mutationFn: (body: PublicImportInput) =>
      api<{ item: Extension; changed: boolean }>(endpoint(projectId, 'public-import'), {
        method: 'POST',
        body,
      }),
    onMutate: async () => client.cancelQueries({ queryKey: list }),
    onSuccess: async ({ item }) => {
      client.setQueryData<Extension[]>(list, (items) =>
        items?.some((old) => old.id === item.id)
          ? items.map((old) => (old.id === item.id ? item : old))
          : [...(items ?? []), item],
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: list }),
        ...(item.kind === 'skill' ? [invalidateSkillCatalogs(client, projectId)] : []),
      ]);
    },
  });
}
