/**
 * @file 提供任务规划设置的读取和局部更新。
 * @implementation 按共享契约校验请求，事务内合并当前设置，单项恢复继承时删除对应模型覆盖。
 * @updated 2026-11-28T21:12:24+08:00
 */
import { AppError } from '../../../shared/errors.js';
import { taskPlanningPatchSchema } from '../../../shared/task-planning.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createTaskPlanningRoutes(
  store: Pick<Store, 'repos' | 'transaction'>,
  isShuttingDown: () => boolean,
): RouteHandler {
  const preferences = store.repos.taskPlanning;
  return async ({ req, res, url, method }) => {
    if (url.pathname !== '/api/settings/task-planning') return false;
    if (method === 'GET') return json(res, preferences.read());
    if (method !== 'PATCH') return false;
    const patch = taskPlanningPatchSchema.parse(await body(req));
    if (isShuttingDown()) throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
    const saved = store.transaction(() => {
      const current = preferences.read();
      const { modelOverride } = patch;
      if (modelOverride) {
        const { model, mode } = modelOverride;
        current.modelOverrides = current.modelOverrides.filter((entry) => entry.model !== model);
        if (mode !== null) current.modelOverrides.push({ model, mode });
      }
      if (patch.mode !== undefined) current.mode = patch.mode;
      if (patch.prompt !== undefined) current.prompt = patch.prompt;
      return preferences.save(current);
    });
    return json(res, saved);
  };
}
