/**
 * @file 提供全局、项目及会话的 Skill 继承设置。
 * @implementation 校验范围和会话状态，更新继承后唤醒待处理消息调度。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { z } from 'zod';
import { skillInheritancePatchSchema } from '../../../shared/skill-inheritance.js';
import { AppError } from '../../../shared/errors.js';
import type { SkillScope } from '../../modules/skills/scope.js';
import type { SkillInheritance } from '../../skill-inheritance.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

const inheritanceScope = z.strictObject({
  projectId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
  native: z.literal('1').optional(),
  automatic: z.literal('1').optional(),
});

export function createSkillRoutes({
  store,
  skills,
  inheritance,
  nativeExecution,
  wakeQueue,
}: {
  store: Pick<Store, 'get'>;
  skills: Pick<SkillScope, 'context'>;
  inheritance: Pick<SkillInheritance, 'update' | 'snapshot'>;
  nativeExecution: boolean;
  wakeQueue(): void;
}): RouteHandler {
  return async ({ req, res, url, method }) => {
    if (url.pathname !== '/api/skill-inheritance' || (method !== 'GET' && method !== 'PATCH'))
      return false;
    const patch =
      method === 'PATCH' ? skillInheritancePatchSchema.parse(await body(req)) : undefined;
    const scope = inheritanceScope.parse(Object.fromEntries(url.searchParams));
    if (
      (scope.sessionId && scope.projectId) ||
      ((scope.native || scope.automatic) && !scope.sessionId) ||
      (scope.native && scope.automatic)
    )
      throw new AppError('EXTENSION_UNAVAILABLE', 'Skill 设置范围无效。', 400);
    const session = scope.sessionId ? store.get('sessions', scope.sessionId) : undefined;
    if (session && patch && session.status !== 'active')
      throw new AppError('SESSION_ARCHIVED', '请先恢复归档会话。', 409);
    const projectId = session?.projectId ?? scope.projectId;
    const context = projectId
      ? skills.context(
          projectId,
          session,
          session ? scope.native === '1' : true,
          undefined,
          scope.automatic === '1',
        )
      : { native: nativeExecution };
    const view = patch ? inheritance.update(context, patch) : inheritance.snapshot(context).view;
    if (patch) wakeQueue();
    return json(res, view);
  };
}
