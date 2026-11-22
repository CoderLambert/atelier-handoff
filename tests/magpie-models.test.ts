/**
 * @file 验证 Magpie 目录发现、独立开关和运行分流。
 * @implementation 使用回环网关替身和原生 Agent SDK 覆盖目录分页、模型 ID 转换、关闭时拒绝发送与重试、在途发现取消及重启后的配置。
 * @updated 2026-11-22T13:51:28+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { magpieModels, magpieOrigin } from '../server/magpie-models.js';
import type { GatewayModelCatalog, Run, Session } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('Magpie accepts loopback origins and follows bounded model pagination', async () => {
  assert.equal(magpieOrigin('http://localhost:3425/'), 'http://localhost:3425');
  assert.equal(magpieOrigin('https://example.test'), undefined);
  assert.equal(magpieOrigin('http://a:b@127.0.0.1:3425'), undefined);
  const requests: (string | null)[] = [];
  const fixture = createServer((request, response) => {
    const after = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('after_id');
    requests.push(after);
    response.end(
      JSON.stringify(
        after
          ? {
              data: [{ id: 'fixture/other' }, { id: 'fixture/no-tools', tool_call: false }],
              has_more: false,
            }
          : {
              data: [
                {
                  id: 'fixture/chat',
                  display_name: 'Fixture Chat',
                  reasoning_levels: ['none', 'medium'],
                },
              ],
              has_more: true,
              last_id: 'fixture/chat',
            },
      ),
    );
  });
  const origin = await listen(fixture);
  try {
    const catalog = await magpieModels(origin);
    assert.deepEqual(requests, [null, 'fixture/chat']);
    assert.equal(catalog.discovery.status, 'ready');
    assert.deepEqual(
      catalog.models.map(({ id }) => id),
      ['magpie:fixture/chat', 'magpie:fixture/other'],
    );
    assert.deepEqual(catalog.models[0]?.supportedEfforts, ['medium']);
  } finally {
    await close(fixture);
  }
});

test(
  'merged Magpie picks reach the native messages endpoint with the unprefixed model ID',
  { timeout: 30_000 },
  async () => {
    const parent = await mkdtemp(join(tmpdir(), 'atelier-magpie-test-'));
    const project = join(parent, 'project');
    await mkdir(project);
    const model = 'fixture/shared';
    let magpieDown = false;
    let catalogRequests = 0;
    let holdCatalog: (() => void) | undefined;
    const magpieRequests: unknown[] = [];
    let shuntInference = 0;
    const shunt = createServer((request, response) => {
      if (request.method === 'POST') shuntInference++;
      response.end(JSON.stringify({ data: [{ model }] }));
    });
    const magpie = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (magpieDown) return response.writeHead(503).end();
      if (path === '/v1/models') {
        catalogRequests++;
        if (holdCatalog) {
          holdCatalog();
          return;
        }
        return response.end(
          JSON.stringify({ data: [{ id: model, display_name: 'Magpie Shared' }] }),
        );
      }
      if (path !== '/v1/messages') return response.writeHead(404).end();
      const chunks: Buffer[] = [];
      for await (const value of request) chunks.push(Buffer.from(value));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: unknown };
      magpieRequests.push(body.model);
      sendModelReply(response, model, 'Magpie fixture response');
    });
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      const [shuntOrigin, magpieOrigin] = await Promise.all([listen(shunt), listen(magpie)]);
      app = await createApp({
        root: process.cwd(),
        data: join(parent, 'data'),
        magpie: magpieOrigin,
      });
      app.store.setConfig({
        ...app.store.config(),
        gateway: shuntOrigin,
        managedGateway: false,
        model,
      });
      const base = await listen(app.server);
      const { csrfToken } = await fetch(base + '/api/bootstrap').then((r) => r.json());
      async function request<T>(
        path: string,
        method = 'GET',
        data?: unknown,
        status = 200,
      ): Promise<T> {
        const response = await fetch(base + path, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': csrfToken },
          body: data === undefined ? undefined : JSON.stringify(data),
        });
        const result: unknown = await response.json();
        assert.equal(response.status, status, JSON.stringify(result));
        return result as T;
      }
      const selection = `magpie:${model}`;
      await request('/api/config', 'PATCH', { model: selection });
      const disabledCatalog = await request<GatewayModelCatalog>('/api/models');
      assert.equal(disabledCatalog.defaultModel, selection);
      assert.deepEqual(
        disabledCatalog.models.map(({ id }) => id),
        [model],
      );
      assert.equal(disabledCatalog.discovery.magpie, undefined);
      assert.equal(catalogRequests, 0);
      await request('/api/config', 'PATCH', { magpieEnabled: true });
      assert.equal(app.store.config().magpieEnabled, true);
      const catalog = await request<GatewayModelCatalog>('/api/models');
      assert.deepEqual(
        catalog.models.map(({ id }) => id),
        [model, `magpie:${model}`],
      );
      assert.equal(catalog.models[1]?.source, 'magpie');
      assert.equal(catalog.discovery.magpie?.status, 'ready');
      const { project: created } = await request<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: project },
        201,
      );
      const { session } = await request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: created.id },
        201,
      );
      const send = <T>(status: number) =>
        request<T>(
          `/api/sessions/${session.id}/messages`,
          'POST',
          { text: 'Magpie fixture', model: `magpie:${model}`, idempotencyKey: randomUUID() },
          status,
        );
      const { run } = await send<{ run: Run }>(202);
      assert.equal(run.config.gateway, magpieOrigin);
      assert.equal(run.config.model, `magpie:${model}`);
      const deadline = Date.now() + 12_000;
      let complete = false;
      while (Date.now() < deadline) {
        const current: Run = app.store.get('runs', run.id);
        if (current.status === 'completed') {
          complete = true;
          break;
        }
        if (['failed', 'interrupted', 'stopped'].includes(current.status))
          assert.fail(current.error ?? current.status);
        await delay(30);
      }
      assert.ok(complete, 'Agent run completes');
      assert.ok(magpieRequests.length > 0 && magpieRequests.every((id) => id === model));
      assert.equal(shuntInference, 0);
      magpieDown = true;
      assert.deepEqual(
        (await request<GatewayModelCatalog>('/api/models')).models.map(({ id }) => id),
        [model],
      );
      const error = await send<{ error: { code: string } }>(503);
      assert.equal(error.error.code, 'SDK_UNAVAILABLE');
      assert.equal(shuntInference, 0);

      magpieDown = false;
      const started = new Promise<void>((resolve) => {
        holdCatalog = resolve;
      });
      const refresh = request<GatewayModelCatalog>('/api/models?refresh=1');
      await started;
      await request('/api/config', 'PATCH', { magpieEnabled: false });
      assert.deepEqual(
        (await refresh).models.map(({ id }) => id),
        [model],
      );
      holdCatalog = undefined;
      const requestsAfterDisable = catalogRequests;
      const inferenceAfterDisable = magpieRequests.length;
      assert.equal((await send<{ error: { code: string } }>(409)).error.code, 'MAGPIE_DISABLED');
      for (const path of [`/api/sessions/${session.id}/messages`, `/api/runs/${run.id}/retry`]) {
        const result = await request<{ error: { code: string } }>(
          path,
          'POST',
          { text: 'Use saved model', idempotencyKey: randomUUID() },
          409,
        );
        assert.equal(result.error.code, 'MAGPIE_DISABLED');
      }
      assert.equal(catalogRequests, requestsAfterDisable);
      assert.equal(magpieRequests.length, inferenceAfterDisable);
      assert.equal(shuntInference, 0);
      assert.equal(app.store.list('runs').length, 1);
      await app.close();
      app = await createApp({
        root: process.cwd(),
        data: join(parent, 'data'),
        magpie: magpieOrigin,
      });
      assert.equal(app.store.config().magpieEnabled, false);
      assert.equal(app.store.config().model, selection);
    } finally {
      await app?.close();
      await Promise.all([close(shunt), close(magpie)]);
      await rm(parent, { recursive: true, force: true });
    }
  },
);
