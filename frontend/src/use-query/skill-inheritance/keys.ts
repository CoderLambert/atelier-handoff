/**
 * @file 定义 Skill 继承查询的范围、缓存键和接口地址。
 * @implementation 按全局、项目、未发送草稿和会话范围生成查询键及请求参数，按项目更新相关缓存。
 * @updated 2026-11-28T15:51:00+08:00
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

export type SessionSkillScope = {
  projectId: string;
  mode: 'controlled' | 'native' | 'automatic';
} & ({ type: 'session'; sessionId: string } | { type: 'draft'; sessionId?: never });

export type SkillInheritanceScope =
  { type: 'global' } | { type: 'project'; projectId: string } | SessionSkillScope;

export const skillInheritanceKeys = {
  all: ['skill-inheritance'] as const,
  view: (scope: SkillInheritanceScope) => [...skillInheritanceKeys.all, scope] as const,
  update: ['skill-inheritance', 'update'] as const,
};

export function skillInheritanceEndpoint(scope: SkillInheritanceScope) {
  const params = new URLSearchParams();
  if (scope.type === 'project') params.set('projectId', scope.projectId);
  if (scope.type === 'draft' || scope.type === 'session') {
    if (scope.type === 'draft') {
      params.set('projectId', scope.projectId);
      params.set('draft', '1');
    } else {
      params.set('sessionId', scope.sessionId);
    }
    if (scope.mode !== 'controlled') params.set(scope.mode, '1');
  }
  const query = params.toString();
  return `/api/skill-inheritance${query ? `?${query}` : ''}`;
}

export function invalidateSkillCatalogs(client: QueryClient, projectId: string) {
  return client.invalidateQueries({
    queryKey: skillInheritanceKeys.all,
    predicate: ({ queryKey }) => {
      const scope = queryKey[1];
      return Boolean(
        scope &&
        typeof scope === 'object' &&
        'type' in scope &&
        (scope.type === 'session' || scope.type === 'project' || scope.type === 'draft') &&
        'projectId' in scope &&
        scope.projectId === projectId,
      );
    },
  });
}

export function useInvalidateSkillCatalogs(projectId: string) {
  const client = useQueryClient();
  return () => invalidateSkillCatalogs(client, projectId);
}
