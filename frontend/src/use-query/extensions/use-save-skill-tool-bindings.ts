/**
 * @file 保存 Skill 的工具绑定配置。
 * @implementation 按项目串行保存绑定并更新绑定缓存，同时刷新扩展目录列表。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SkillToolBinding } from '@shared/extensions';
import { api } from '@/api/client';
import { extensionKeys } from './keys';
import {
  bindingsOf,
  toolBindingsEndpoint,
  type ToolBindingsResponse,
} from './use-skill-tool-bindings';

export function useSaveSkillToolBindings(projectId: string, skillId: string) {
  const client = useQueryClient();
  const queryKey = extensionKeys.toolBindings(projectId, skillId);
  return useMutation({
    mutationKey: extensionKeys.mutations(projectId),
    scope: { id: `extensions:${projectId}` },
    mutationFn: async (bindings: SkillToolBinding[]) =>
      bindingsOf(
        await api<ToolBindingsResponse>(toolBindingsEndpoint(projectId, skillId), {
          method: 'PUT',
          body: { bindings },
        }),
      ),
    onMutate: async () => {
      await client.cancelQueries({ queryKey });
    },
    onSuccess: async (bindings) => {
      client.setQueryData(queryKey, bindings);
      await client.invalidateQueries({ queryKey: extensionKeys.list(projectId) });
    },
  });
}
