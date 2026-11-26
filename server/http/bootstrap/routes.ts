/**
 * @file 提供桌面工作台的初始快照和令牌。
 * @implementation 复用项目可用性及网关状态服务，返回当前事件游标和有限的最近记录。
 * @updated 2026-11-26T23:20:03+08:00
 */
import type { GatewayService } from '../../modules/gateway/service.js';
import type { ProjectService } from '../../modules/projects/service.js';
import { publicSession } from '../../session-forks.js';
import type { Store } from '../../store.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createBootstrapRoutes({
  store,
  projects,
  gateway,
  csrfToken,
}: {
  store: Pick<Store, 'cursor' | 'list' | 'workspaceLayout'>;
  projects: Pick<ProjectService, 'list'>;
  gateway: Pick<GatewayService, 'configInfo'>;
  csrfToken: string;
}): RouteHandler {
  return async ({ res, url, method }) => {
    if (url.pathname !== '/api/bootstrap' || method !== 'GET') return false;
    const projectList = await projects.list();
    const info = await gateway.configInfo();
    return json(res, {
      csrfToken,
      cursor: store.cursor(),
      projects: projectList,
      workspaceLocation: store.workspaceLayout.readLocation(),
      workspaceLastSession: store.workspaceLayout.readLastSession(),
      sessions: store
        .list('sessions')
        .filter((session) => !session.creatingFork)
        .map(publicSession)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      runs: store
        .list('runs')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100),
      artifacts: store
        .list('artifacts')
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100),
      ...info,
    });
  };
}
