/**
 * @file 查询 Skill 的工具绑定配置。
 * @implementation 按项目和 Skill 标识读取并校验绑定列表。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import type { SkillToolBinding } from '@shared/extensions';
import { api } from '@/api/client';
import { getTranslator } from '@/i18n';
import { endpoint, extensionKeys } from './keys';

export interface ToolBindingsResponse {
  bindings: SkillToolBinding[];
}

export function bindingsOf(result: ToolBindingsResponse) {
  const t = getTranslator('extensions');
  if (!Array.isArray(result?.bindings)) throw new Error(t('extensions.missingBindings'));
  return result.bindings;
}

export const toolBindingsEndpoint = (projectId: string, skillId: string) =>
  endpoint(projectId, `${encodeURIComponent(skillId)}/tool-bindings`);

export function useSkillToolBindings(projectId: string, skillId: string) {
  return useQuery({
    queryKey: extensionKeys.toolBindings(projectId, skillId),
    queryFn: async ({ signal }) =>
      bindingsOf(
        await api<ToolBindingsResponse>(toolBindingsEndpoint(projectId, skillId), { signal }),
      ),
    enabled: Boolean(projectId && skillId),
  });
}
