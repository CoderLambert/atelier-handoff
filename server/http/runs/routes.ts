/**
 * @file 提供运行列表、执行轨迹、诊断和控制接口。
 * @implementation 校验运行子路径的请求格式，返回只读记录或将控制交给领域服务。
 * @updated 2026-11-26T23:20:03+08:00
 */
import { z } from 'zod';
import { bashControlSchema } from '../../../shared/bash-execution.js';
import { AppError, activeStatuses } from '../../../shared/types.js';
import { buildRunDiagnostics } from '../../diagnostics.js';
import type { RunControls } from '../../modules/runs/controls.js';
import type { Store } from '../../store.js';
import { body } from '../body.js';
import { json, page } from '../response.js';
import type { RouteHandler } from '../types.js';

export function createRunRoutes(
  store: Pick<Store, 'get' | 'list' | 'history' | 'runHistory'>,
  controls: RunControls,
): RouteHandler {
  return async ({ req, res, url, parts, method }) => {
    if (parts[0] !== 'api' || parts[1] !== 'runs') return false;
    if (parts.length === 2 && method === 'GET')
      return json(
        res,
        page(
          store
            .list('runs')
            .filter((run) =>
              (['sessionId', 'projectId', 'status'] as const).every(
                (key) => !url.searchParams.get(key) || run[key] === url.searchParams.get(key),
              ),
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          url,
        ),
      );
    const id = parts[2];
    if (id === undefined) throw new AppError('NOT_FOUND', '记录不存在或已删除。', 404);
    const run = store.get('runs', id);
    if (parts.length === 3 && method === 'GET')
      return json(res, {
        run,
        tools: store.list('tools').filter((t) => t.runId === run.id),
        permissions: store.list('permissions').filter((p) => p.runId === run.id),
        artifacts: store.list('artifacts').filter((a) => a.runId === run.id),
        events: store.history(run.sessionId).filter((e) => e.runId === run.id),
      });
    if (parts.length === 4 && parts[3] === 'trace' && method === 'GET')
      return json(res, store.runHistory(run.id));
    if (parts.length === 4 && parts[3] === 'diagnostics.json' && method === 'GET') {
      const tools = store.list('tools').filter((tool) => tool.runId === run.id);
      const diagnostics = buildRunDiagnostics(run, store.runHistory(run.id), tools);
      const filenameId = /^[a-f0-9-]{36}$/.test(run.id) ? `-${run.id}` : '';
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="atelier-diagnostics${filenameId}.json"`,
      );
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(diagnostics, null, 2) + '\n');
      return true;
    }
    if (parts.length === 6 && parts[3] === 'tools' && parts[5] === 'bash' && method === 'POST') {
      const toolId = z.string().min(1).max(500).parse(parts[4]);
      const { action } = bashControlSchema.parse(await body(req));
      await controls.controlBash(run, toolId, action);
      return json(res, { ok: true });
    }
    if (
      parts.length === 6 &&
      parts[3] === 'subagents' &&
      parts[5] === 'stop' &&
      method === 'POST'
    ) {
      z.strictObject({}).parse(await body(req));
      const subagentId = z.string().min(1).max(200).parse(parts[4]);
      await controls.stopSubagent(run, subagentId);
      return json(res, { ok: true });
    }
    if (parts[3] === 'stop' && method === 'POST') {
      await body(req);
      return json(res, { run: controls.stop(run) });
    }
    if (parts[3] === 'retry' && method === 'POST') {
      if (activeStatuses.includes(run.status))
        throw new AppError('RUN_ACTIVE', '当前运行尚未结束。', 409);
      const { idempotencyKey } = z
        .object({ idempotencyKey: z.string().uuid() })
        .parse(await body(req));
      return json(res, await controls.retry(run, idempotencyKey), 202);
    }
    return false;
  };
}
