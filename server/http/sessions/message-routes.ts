/**
 * @file 提供会话消息和待处理队列的 HTTP 操作。
 * @implementation 校验后交由运行启动和队列用例处理，读取消息列表或返回已有操作回执。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { z } from 'zod';
import { AppError, type Session } from '../../../shared/types.js';
import type { QueueActions } from '../../modules/message-queue/actions.js';
import type { StartRun } from '../../modules/runs/create-run.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json, page } from '../response.js';
import type { RouteRequest } from '../types.js';

const insertionInput = z.strictObject({
  runId: z.string().uuid(),
  mode: z.enum(['live', 'priority']),
});

export function createSessionMessageRoutes({
  store,
  createRun,
  queue,
}: {
  store: Pick<Store, 'list'>;
  createRun: StartRun;
  queue: QueueActions;
}) {
  return async (
    { req, res, url, parts, method }: RouteRequest,
    session: Session,
  ): Promise<boolean> => {
    const { id } = session;
    if (parts[3] === 'messages' && parts.length === 4) {
      if (method === 'GET')
        return json(
          res,
          page(
            store.list('messages').filter((m) => m.sessionId === id),
            url,
          ),
        );
      if (method === 'POST') return json(res, await createRun(id, await body(req)), 202);
    }
    if (parts[3] !== 'message-queue') return false;
    if (parts.length === 6 && parts[5] === 'insert' && method === 'POST') {
      const itemId = z.string().uuid().parse(parts[4]);
      const { runId, mode } = insertionInput.parse(await body(req));
      await queue.insert(id, itemId, runId, mode);
      return json(res, { ok: true });
    }
    if (parts.length === 5) {
      if (method === 'DELETE') queue.withdraw(id, z.string().uuid().parse(parts[4]));
      else if (method === 'POST' && parts[4] === 'resume') {
        z.strictObject({}).parse(await body(req));
        await queue.resume(session);
      } else throw new AppError('NOT_FOUND', '接口不存在。', 404);
      return json(res, { ok: true });
    }
    return false;
  };
}
