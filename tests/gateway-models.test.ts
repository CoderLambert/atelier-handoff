/**
 * @file 验证网关目录合并和会话模型选择。
 * @implementation 通过回环网关、Codex 目录替身和运行器替身检查目录合并、路由元数据、会话隔离、执行快照和重试。
 * @updated 2026-11-20T17:08:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { gatewayModels } from '../server/gateway-models.js';
import { now } from '../shared/types.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('configured routes, session model overrides, and readonly retry keep their own model IDs', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'atelier-gateway-models-'));
  const projectPath = join(temp, 'project');
  await mkdir(projectPath);
  let routesAvailable = true;
  let provider = 'fixture';
  const gateway = createServer((req, res) => {
    if (req.url === '/health') return res.end('{}');
    if (req.url !== '/routes' || !routesAvailable) return res.writeHead(404).end();
    res.end(
      JSON.stringify({
        data: [
          {
            model: 'fixture-alternate',
            provider,
            effort: 'high',
            service_tier: 'priority',
          },
          { model: 'not a model ID' },
        ],
        routers: [{ model: 'fixture-auto' }],
      }),
    );
  });
  const gatewayUrl = await listen(gateway);
  const app = await createApp({
    root: process.cwd(),
    data: join(temp, 'data'),
    runnerFactory: (store) => ({
      start(run) {
        store.update('runs', run.id, { status: 'completed', endedAt: now() });
      },
      stop() {},
      async shutdown() {},
    }),
  });
  try {
    app.store.setConfig({ ...app.store.config(), gateway: gatewayUrl, model: 'fixture-default' });
    const base = await listen(app.server);
    const { csrfToken } = await fetch(base + '/api/bootstrap').then((r) => r.json());
    async function api(path: string, method = 'GET', body?: unknown, status = 200) {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = await res.json();
      assert.equal(res.status, status, JSON.stringify(json));
      return json;
    }
    assert.deepEqual(await api('/api/models'), {
      defaultModel: 'fixture-default',
      routesAvailable: true,
      models: [
        { id: 'fixture-default' },
        { id: 'fixture-auto' },
        {
          id: 'fixture-alternate',
          provider,
          effort: 'high',
          serviceTier: 'priority',
        },
      ],
    });
    provider = 'chatgpt-plan';
    const merged = await gatewayModels(app.store.config(), async () => [
      { id: 'fixture-alternate', displayName: 'Alternate', provider: 'chatgpt-plan' },
      { id: 'fixture-codex', displayName: 'Codex catalog model', provider: 'chatgpt-plan' },
    ]);
    assert.deepEqual(
      merged.models.find((entry) => entry.id === 'fixture-alternate'),
      {
        id: 'fixture-alternate',
        displayName: 'Alternate',
        provider: 'chatgpt-plan',
        effort: 'high',
        serviceTier: 'priority',
      },
    );
    assert.ok(merged.models.some((entry) => entry.id === 'fixture-codex'));
    routesAvailable = false;
    assert.deepEqual(await api('/api/models'), {
      defaultModel: 'fixture-default',
      routesAvailable: false,
      models: [{ id: 'fixture-default' }],
    });
    const { project } = await api('/api/projects', 'POST', { path: projectPath }, 201);
    const { session: first } = await api('/api/sessions', 'POST', { projectId: project.id }, 201);
    const { session: second } = await api('/api/sessions', 'POST', { projectId: project.id }, 201);
    const send = (id: string, model?: string) =>
      api(
        `/api/sessions/${id}/messages`,
        'POST',
        { text: 'fixture', model, idempotencyKey: randomUUID() },
        202,
      );
    const sessionRoute = `/api/sessions/${first.id}`;
    await api(sessionRoute, 'PATCH', { draft: { ...first.draft, model: 'fixture-alternate' } });
    const { run: original } = await send(first.id, 'fixture-alternate');
    assert.equal(original.config.model, 'fixture-alternate');
    assert.equal((await api(sessionRoute)).session.draft.model, 'fixture-alternate');
    assert.equal((await send(second.id)).run.config.model, 'fixture-default');
    await api(sessionRoute, 'PATCH', { draft: first.draft });
    assert.equal((await send(first.id)).run.config.model, 'fixture-default');
    assert.equal((await api(sessionRoute)).session.draft.model, undefined);
    assert.equal(app.store.get('runs', original.id).config.model, 'fixture-alternate');
    const { run: retry } = await api(
      `/api/runs/${original.id}/retry`,
      'POST',
      { idempotencyKey: randomUUID() },
      202,
    );
    assert.equal(retry.config.model, 'fixture-alternate');
    assert.equal(retry.mode, 'readonly');
    assert.equal(app.store.get('sessions', first.id).draft.model, undefined);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});
