/**
 * @file 提供项目智能体的配置和版本操作 HTTP 接口。
 * @implementation 按项目与智能体路径匹配，复用领域服务校验配置，归档和复制前解析基准版本。
 * @updated 2026-11-26T22:26:22+08:00
 */
import { z } from 'zod';
import { AppError } from '../../../shared/types.js';
import type { AgentProfiles } from '../../agent-profiles.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteHandler } from '../types.js';

const baseRevision = z.object({ baseRevisionId: z.string().uuid() });

export function createAgentRoutes(
  agents: Pick<AgentProfiles, 'list' | 'create' | 'card' | 'update' | 'archive' | 'duplicate'>,
): RouteHandler {
  return async ({ req, res, parts, method }) => {
    const [api, projects, projectId, resource, id, action] = parts;
    if (
      api !== 'api' ||
      projects !== 'projects' ||
      projectId === undefined ||
      resource !== 'agents'
    )
      return false;
    if (parts.length === 4 && method === 'GET') return json(res, { items: agents.list(projectId) });
    if (parts.length === 4 && method === 'POST')
      return json(res, { agent: agents.create(projectId, await body(req)) }, 201);
    if (parts.length === 5 && id && method === 'GET')
      return json(res, { agent: agents.card(projectId, id) });
    if (parts.length === 5 && id && method === 'PATCH')
      return json(res, { agent: agents.update(projectId, id, await body(req)) });
    if (
      parts.length === 6 &&
      id &&
      method === 'POST' &&
      (action === 'archive' || action === 'duplicate')
    ) {
      const { baseRevisionId } = baseRevision.parse(await body(req));
      return action === 'archive'
        ? json(res, { agent: agents.archive(projectId, id, baseRevisionId) })
        : json(res, { agent: agents.duplicate(projectId, id, baseRevisionId) }, 201);
    }
    throw new AppError('NOT_FOUND', '接口不存在。', 404);
  };
}
