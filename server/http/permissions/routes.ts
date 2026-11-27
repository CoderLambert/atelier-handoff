/**
 * @file 提供工具审批详情、Diff 与裁决接口。
 * @implementation 解析决定与版本号，将实际授权复核交给审批服务。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import type { PermissionService } from '../../permissions.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

const decision = z.object({ decision: z.enum(['allow', 'deny']), version: z.string().uuid() });

export function createPermissionRoutes(
  store: Pick<Store, 'get'>,
  permissions: Pick<PermissionService, 'decide'>,
): RouteHandler {
  return async ({ req, res, parts, method }) => {
    if (parts[0] !== 'api' || parts[1] !== 'permissions') return false;
    const id = parts[2];
    if (id === undefined) throw new AppError('NOT_FOUND', '记录不存在或已删除。', 404);
    const permission = store.get('permissions', id);
    if (parts.length === 3 && method === 'GET') return json(res, { permission });
    if (parts[3] === 'diff' && method === 'GET')
      return json(res, {
        diff: permission.diff,
        before: permission.before,
        after: permission.after,
        path: permission.path,
        kind: permission.kind,
        version: permission.version,
      });
    if (parts[3] === 'decision' && method === 'POST') {
      const input = decision.parse(await body(req));
      return json(res, {
        permission: await permissions.decide(permission.id, input.decision, input.version),
      });
    }
    return false;
  };
}
