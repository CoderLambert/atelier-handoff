/**
 * @file 注册会话读取、生命周期、消息与附件路由。
 * @implementation 先处理列表和分支创建，再验证会话就绪后将子路径交给各自适配器。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { z } from 'zod';
import { gitRestoreRequest } from '../../../shared/git-workbench.js';
import { AppError, type Session } from '../../../shared/types.js';
import type { DevelopmentWorktrees } from '../../modules/git/development-worktrees.js';
import type { createGetSessionSnapshot } from '../../modules/sessions/get-session-snapshot.js';
import type { SessionLifecycle } from '../../modules/sessions/lifecycle.js';
import { publicSession, sessionForkRequest, type SessionForks } from '../../session-forks.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json, page } from '../response.js';
import type { RouteHandler, RouteRequest } from '../types.js';
import { sessionCreateInput, sessionUpdateInput } from './inputs.js';

export function createSessionRoutes({
  store,
  lifecycle,
  snapshot,
  forks,
  worktrees,
  messages,
  attachments,
}: {
  store: Pick<Store, 'get' | 'list'>;
  lifecycle: SessionLifecycle;
  snapshot: ReturnType<typeof createGetSessionSnapshot>;
  forks: Pick<SessionForks, 'restoreLegacyAnchors'>;
  worktrees: Pick<DevelopmentWorktrees, 'sessionWorkspace'>;
  messages(request: RouteRequest, session: Session): Promise<boolean>;
  attachments(request: RouteRequest, sessionId: string): Promise<boolean>;
}): RouteHandler {
  return async (request) => {
    const { req, res, url, parts, method } = request;
    if (parts[0] !== 'api' || parts[1] !== 'sessions') return false;
    if (parts.length === 2 && method === 'GET') {
      const query = (url.searchParams.get('query') || '').toLowerCase();
      const projectId = url.searchParams.get('projectId');
      return json(
        res,
        page(
          store
            .list('sessions')
            .filter(
              (s) =>
                !s.creatingFork &&
                (!query || s.title.toLowerCase().includes(query)) &&
                (!projectId || s.projectId === projectId) &&
                (url.searchParams.get('includeArchived') === 'true' || s.status === 'active'),
            )
            .map(publicSession)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          url,
        ),
      );
    }
    if (parts.length === 2 && method === 'POST')
      return json(
        res,
        { session: await lifecycle.create(sessionCreateInput.parse(await body(req))) },
        201,
      );
    const id = parts[2];
    if (id === undefined) throw new AppError('NOT_FOUND', '记录不存在或已删除。', 404);
    if (parts.length === 4 && parts[3] === 'fork' && method === 'POST')
      return json(
        res,
        { session: await lifecycle.fork(id, sessionForkRequest.parse(await body(req))) },
        201,
      );
    const session = store.get('sessions', id);
    if (session.creatingFork)
      throw new AppError('FORK_NOT_READY', '分支仍在创建，请稍后重试。', 409, true);
    if (parts.length === 3 && method === 'GET') {
      const initial = snapshot(id);
      const restored = await forks.restoreLegacyAnchors(initial);
      const records = restored ? snapshot(id) : initial;
      const workspace = await worktrees.sessionWorkspace(records.session);
      return json(res, { ...records, ...(workspace ? { workspace } : {}) });
    }
    if (parts.length === 4 && parts[3] === 'upgrade-agent' && method === 'POST') {
      const { revisionId } = z.object({ revisionId: z.string().uuid() }).parse(await body(req));
      return json(res, { session: lifecycle.upgradeAgent(id, revisionId) });
    }
    if (
      parts.length === 5 &&
      parts[3] === 'worktree' &&
      parts[4] === 'restore' &&
      method === 'POST'
    )
      return json(res, await lifecycle.restore(session, gitRestoreRequest.parse(await body(req))));
    if (parts.length === 3 && method === 'PATCH')
      return json(res, await lifecycle.update(id, sessionUpdateInput.parse(await body(req))));
    if (parts.length === 3 && method === 'DELETE') {
      await lifecycle.remove(id);
      return json(res, { ok: true });
    }
    if (parts[3] === 'messages' || parts[3] === 'message-queue') return messages(request, session);
    if (parts[3] === 'attachments') return attachments(request, id);
    return false;
  };
}
