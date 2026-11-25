/**
 * @file 验证工作区位置白名单与跨运行时恢复。
 * @implementation 覆盖合法会话路由（含终端）、非法子路径，以及隔离数据根中保存位置后重启运行时的恢复行为。
 * @updated 2026-11-26T04:17:21+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { isWorkspaceLocation } from '../shared/workspace-location.js';

const routes = [
  (id: string) => `/sessions/${id}`,
  (id: string) => `/sessions/${id}/trace/${randomUUID()}`,
  (id: string) => `/sessions/${id}/messages/${randomUUID()}`,
  (id: string) => `/sessions/${id}/artifacts`,
  (id: string) => `/sessions/${id}/browser`,
  (id: string) => `/sessions/${id}/terminal`,
];

test('only typed workspace destinations can be remembered', () => {
  const id = randomUUID();
  for (const path of [...routes.map((route) => route(id)), '/settings/layout', '/extensions']) {
    assert.equal(isWorkspaceLocation(path), true, path);
  }
  for (const path of [
    '/',
    '//elsewhere',
    '/api/models',
    '/sessions/unknown',
    `/sessions/${id}/messages`,
    `/sessions/${id}/browser/extra`,
    `/sessions/${id}/terminal/extra`,
  ]) {
    assert.equal(isWorkspaceLocation(path), false, path);
  }
});

test('the last workspace route is shared across runtime restarts with different ports', async () => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-location-test-'));
  const makeApp = () => createApp({ root: process.cwd(), data });
  let app = await makeApp();
  async function origin() {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const bound = app.server.address();
    assert.ok(bound && typeof bound === 'object');
    return `http://127.0.0.1:${bound.port}`;
  }
  try {
    const first = await origin();
    const bootstrap = await fetch(first + '/api/bootstrap').then((response) => response.json());
    assert.equal(bootstrap.workspaceLocation, undefined);
    const patch = (path: string) =>
      fetch(first + '/api/settings/workspace-location', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': bootstrap.csrfToken },
        body: JSON.stringify({ path }),
      });
    const sessionId = randomUUID();
    assert.equal((await patch(`/sessions/${sessionId}/trace`)).status, 200);
    assert.equal((await patch('/settings/diagnostics')).status, 200);
    assert.equal((await patch('/api/config')).status, 400);
    await app.close();
    app = await makeApp();
    const reopened = await origin();
    const restored = await fetch(reopened + '/api/bootstrap').then((response) => response.json());
    assert.equal(restored.workspaceLocation, '/settings/diagnostics');
    assert.equal(restored.workspaceLastSession, sessionId);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
