/**
 * @file 查询指定范围的 Skill 继承视图。
 * @implementation 使用 TanStack Query 发起可取消请求，并用共享 schema 校验响应。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { api } from '@/api/client';
import { useQuery } from '@tanstack/react-query';
import { skillInheritanceViewSchema } from '@shared/skill-inheritance';
import { skillInheritanceEndpoint, skillInheritanceKeys, type SkillInheritanceScope } from './keys';

export function useSkillInheritance(scope: SkillInheritanceScope, enabled = true) {
  return useQuery({
    queryKey: skillInheritanceKeys.view(scope),
    queryFn: async ({ signal }) =>
      skillInheritanceViewSchema.parse(await api(skillInheritanceEndpoint(scope), { signal })),
    enabled,
    staleTime: 0,
    retry: false,
  });
}
