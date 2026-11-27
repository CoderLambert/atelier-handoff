/**
 * @file 提供项目绑定、目录选择和项目文件查询。
 * @implementation 保留取目录窗口的互斥和断连取消，并在读取前核对会话的项目归属。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { z } from 'zod';
import { desktopBrowserAccessUpdateSchema } from '../../../shared/desktop-browser.js';
import { AppError } from '../../../shared/errors.js';
import type { DesktopBrowserAccess } from '../../desktop-browser-access.js';
import { findProjectFiles, listProjectFiles, readProjectText } from '../../files.js';
import type { DevelopmentWorktrees } from '../../modules/git/development-worktrees.js';
import type { ProjectService } from '../../modules/projects/service.js';
import type { pickProjectDirectory } from '../../project-picker.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json, page } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createProjectRoutes({
  projects,
  store,
  worktrees,
  browserAccess,
  pickDirectory,
  isShuttingDown,
}: {
  projects: ProjectService;
  store: Pick<Store, 'get'>;
  worktrees: Pick<DevelopmentWorktrees, 'resolveSession'>;
  browserAccess: Pick<DesktopBrowserAccess, 'read' | 'update'>;
  pickDirectory: typeof pickProjectDirectory;
  isShuttingDown(): boolean;
}): { route: RouteHandler; cancelPicker(): void } {
  let directoryPicker: AbortController | undefined;
  const route: RouteHandler = async ({ req, res, url, parts, method }) => {
    if (parts[0] !== 'api' || parts[1] !== 'projects') return false;
    if (parts.length === 2 && method === 'GET') return json(res, page(await projects.list(), url));
    if (parts.length === 3 && parts[2] === 'pick-directory' && method === 'POST') {
      await body(req);
      if (isShuttingDown()) throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
      if (directoryPicker)
        throw new AppError(
          'PROJECT_PICKER_BUSY',
          '系统目录选择框已打开，请先完成或取消选择。',
          409,
        );
      const picker = new AbortController();
      directoryPicker = picker;
      const cancel = () => picker.abort();
      res.once('close', cancel);
      try {
        return json(res, { path: await pickDirectory(picker.signal) });
      } finally {
        res.off('close', cancel);
        directoryPicker = undefined;
      }
    }
    if (parts.length === 2 && method === 'POST') {
      const input = z.object({ path: z.string().min(1).max(2000) }).parse(await body(req));
      const { project, created } = await projects.bind(input.path);
      return json(res, { project }, created ? 201 : 200);
    }
    const projectId = parts[2];
    if (projectId === undefined || parts.length !== 4) return false;
    if (parts[3] === 'desktop-browser') {
      if (method === 'GET') return json(res, browserAccess.read(projectId));
      if (method === 'PATCH')
        return json(
          res,
          browserAccess.update(projectId, desktopBrowserAccessUpdateSchema.parse(await body(req))),
        );
    }
    if (method === 'GET' && (parts[3] === 'files' || parts[3] === 'file')) {
      const project = store.get('projects', projectId);
      const path = url.searchParams.get('path') || '';
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? store.get('sessions', z.uuid().parse(sessionId)) : undefined;
      if (session && session.projectId !== project.id)
        throw new AppError('CONTEXT_DENIED', '会话不属于此项目。', 403);
      const directory = session ? await worktrees.resolveSession(session) : project.path;
      if (parts[3] === 'files') {
        const query = url.searchParams.get('query');
        return json(
          res,
          query === null
            ? await listProjectFiles(directory, path)
            : await findProjectFiles(directory, query),
        );
      }
      return json(res, { path, text: await readProjectText(directory, path) });
    }
    return false;
  };
  return { route, cancelPicker: () => directoryPicker?.abort() };
}
