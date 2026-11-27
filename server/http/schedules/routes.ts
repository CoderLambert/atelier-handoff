/**
 * @file 提供定时任务的 REST HTTP 路由。
 * @implementation 支持全局/按项目列表、创建、查看、乐观锁更新、删除、手动立即执行及历史记录分页读取。
 * @updated 2026-11-27T13:13:00+08:00
 */
import { AppError } from '../../../shared/errors.js';
import { scheduleStatusSchema } from '../../../shared/schedules.js';
import type { ScheduleScheduler } from '../../modules/schedules/scheduler.js';
import type { ScheduleService } from '../../modules/schedules/service.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createScheduleRoutes(
  service: Pick<ScheduleService, 'list' | 'get' | 'create' | 'update' | 'remove' | 'listRuns'>,
  scheduler: Pick<ScheduleScheduler, 'runNow'>,
): RouteHandler {
  return async ({ req, res, url, parts, method }) => {
    const [api, resource, id, action] = parts;
    if (api !== 'api' || resource !== 'schedules') return false;

    if (parts.length === 2 && method === 'GET') {
      const projectId = url.searchParams.get('projectId') || undefined;
      const rawStatus = url.searchParams.get('status');
      const status = rawStatus ? scheduleStatusSchema.parse(rawStatus) : undefined;
      return json(res, { items: service.list({ projectId, status }) });
    }

    if (parts.length === 2 && method === 'POST') {
      const task = service.create(await body(req), { createdBy: 'user' });
      return json(res, { task }, 201);
    }

    if (parts.length === 3 && id && method === 'GET') {
      return json(res, { task: service.get(id) });
    }

    if (parts.length === 3 && id && method === 'PATCH') {
      return json(res, { task: service.update(id, await body(req)) });
    }

    if (parts.length === 3 && id && method === 'DELETE') {
      service.remove(id);
      return json(res, { deleted: true });
    }

    if (parts.length === 4 && id && action === 'run' && method === 'POST') {
      const run = await scheduler.runNow(id);
      return json(res, { run }, 201);
    }

    if (parts.length === 4 && id && action === 'runs' && method === 'GET') {
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit ? Number(rawLimit) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new AppError('INVALID_INPUT', 'limit 需为 1 到 200 的整数。', 400);
      }
      return json(res, { items: service.listRuns(id, limit) });
    }

    throw new AppError('NOT_FOUND', '接口不存在。', 404);
  };
}
