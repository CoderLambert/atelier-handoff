/**
 * @file 定义 Skill 继承查询的范围、缓存键和接口地址。
 * @implementation 按全局、项目和会话范围生成 TanStack Query 键及请求参数。
 * @updated 2026-11-26T00:06:59+08:00
 */
export type SkillInheritanceScope =
  | { type: 'global' }
  | { type: 'project'; projectId: string }
  | { type: 'session'; sessionId: string; native: boolean };

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
    if (scope.native) params.set('native', '1');
  }
  const query = params.toString();
  return `/api/skill-inheritance${query ? `?${query}` : ''}`;
}
