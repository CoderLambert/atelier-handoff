/**
 * @file 查询指定范围的 Skill 继承视图。
 * @implementation 使用 TanStack Query 发起可取消请求并用共享 schema 校验响应，同时提供有效缓存读取能力。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { api } from '@/api/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { skillInheritanceViewSchema, type SkillInheritanceView } from '@shared/skill-inheritance';
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

export function useReadCachedSkillInheritance(scope: SkillInheritanceScope) {
  const client = useQueryClient();
  return () => {
    const cached = client.getQueryState<SkillInheritanceView>(skillInheritanceKeys.view(scope));
    if (cached?.status !== 'success' || cached.fetchStatus !== 'idle' || cached.isInvalidated)
      return undefined;
    return cached.data?.items ?? [];
  };
}
