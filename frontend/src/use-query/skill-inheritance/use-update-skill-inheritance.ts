/**
 * @file 更新 Skill 继承策略并协调查询缓存。
 * @implementation 串行限制策略更新，校验服务端响应，写入当前范围缓存并使相关查询失效。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { api } from '@/api/client';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { skillInheritanceViewSchema, type SkillInheritancePatch } from '@shared/skill-inheritance';
import { skillInheritanceEndpoint, skillInheritanceKeys, type SkillInheritanceScope } from './keys';

export function useUpdateSkillInheritance(scope: SkillInheritanceScope) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationKey: skillInheritanceKeys.update,
    retry: false,
    mutationFn: ({ scope, patch }: { scope: SkillInheritanceScope; patch: SkillInheritancePatch }) =>
      api(skillInheritanceEndpoint(scope), { method: 'PATCH', body: patch }).then((data) =>
        skillInheritanceViewSchema.parse(data),
      ),
    onSuccess: async (view, { scope }) => {
      const queryKey = skillInheritanceKeys.view(scope);
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, view);
      await client.invalidateQueries({ queryKey: skillInheritanceKeys.all });
    },
  });
  const saving = useIsMutating({ mutationKey: skillInheritanceKeys.update }) > 0;
  return {
    saving,
    error: mutation.error,
    save: (patch: SkillInheritancePatch) => {
      if (!client.isMutating({ mutationKey: skillInheritanceKeys.update })) {
        mutation.mutate({ scope, patch });
      }
    },
  };
}
