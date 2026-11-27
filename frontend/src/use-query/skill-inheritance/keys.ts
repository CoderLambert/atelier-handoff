/**
 * @file 定义 Skill 继承查询的范围、缓存键和接口地址。
 * @implementation 按全局、项目和会话范围生成 TanStack Query 键及请求参数。
 * @updated 2026-11-26T00:06:59+08:00
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

export type SessionSkillScope = {
  type: 'session';
  projectId: string;
  sessionId: string;
  mode: 'controlled' | 'native' | 'automatic';
};

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
  if (scope.type === 'session') {
    params.set('sessionId', scope.sessionId);
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
        (scope.type === 'session' || scope.type === 'project') &&
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
