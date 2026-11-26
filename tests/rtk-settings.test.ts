/**
 * @file 验证 RTK 设置的范围、持久化和 HTTP 边界。
 * @implementation 使用隔离 SQLite 和本地 API 覆盖继承、覆盖、回滚、损坏回退及重启，不调用模型或 Git。
 * @updated 2026-11-26T01:39:35+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { RtkSettings } from '../server/rtk-settings.js';
import { Store } from '../server/store.js';
import { rtkSettingsPatchSchema, rtkSettingsViewSchema } from '../shared/rtk-settings.js';
import { now } from '../shared/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = '/api/rtk-settings';
function addProject(store: Store, path: string) {
  return store.put('projects', {
    id: randomUUID(),
    name: 'Synthetic project',
    path: join(path, randomUUID()),
    branch: '',
    available: true,
    createdAt: now(),
  });
}

test('RTK settings default on and keep project overrides reversible across reopen and rollback', async () => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-rtk-settings-'));
  let store = new Store(data);
  try {
    const a = addProject(store, data);
    const b = addProject(store, data);
    const version = store.db.prepare('PRAGMA user_version').get();
    const config = store.config();
    const inheritance = store.skillInheritance.readGlobal();
    let settings = new RtkSettings(store);
    assert.equal(settings.enabled(a.id), true);
    assert.deepEqual(settings.view(a.id, true, true), {
      globalEnabled: true,
      projectMode: 'follow',
      effectiveEnabled: true,
      source: 'global',
      available: true,
    });
    settings.update(a.id, { type: 'project', mode: 'off' });
    settings.update(a.id, { type: 'project', mode: 'off' });
    assert.equal(settings.enabled(a.id), false);
    assert.equal(settings.enabled(b.id), true);
    settings.update(undefined, { type: 'global', enabled: false });
    settings.update(a.id, { type: 'project', mode: 'on' });
    assert.equal(settings.enabled(a.id), true);
    assert.equal(settings.enabled(b.id), false);
    assert.throws(
      () =>
        store.transaction(() => {
          settings.update(a.id, { type: 'project', mode: 'off' });
          settings.update(undefined, { type: 'global', enabled: true });
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(settings.enabled(a.id), true);
    assert.equal(settings.enabled(b.id), false);
    store.close();
    store = new Store(data);
    settings = new RtkSettings(store);
    assert.equal(settings.enabled(a.id), true);
    assert.equal(settings.enabled(b.id), false);
    assert.equal(settings.view(a.id, false, true).unavailableReason, 'resource-unavailable');
    assert.equal(settings.view(a.id, true, false).unavailableReason, 'native-unavailable');
    settings.update(a.id, { type: 'project', mode: 'follow' });
    assert.equal(settings.enabled(a.id), false);
    settings.update(undefined, { type: 'global', enabled: true });
    assert.equal(settings.enabled(a.id), true);
    assert.equal(settings.enabled(b.id), true);
    assert.deepEqual(store.db.prepare('PRAGMA user_version').get(), version);
    assert.deepEqual(store.config(), config);
    assert.equal(store.skillInheritance.readGlobal(), inheritance);
    assert.throws(() => settings.enabled(randomUUID()));
    assert.throws(() => settings.update(a.id, { type: 'global', enabled: false }));
    assert.throws(() => settings.update(undefined, { type: 'project', mode: 'off' }));
  } finally {
    store.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('invalid stored RTK values disable compression without changing other namespaces', async () => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-rtk-corrupt-'));
  const store = new Store(data);
  try {
    const a = addProject(store, data);
    const settings = new RtkSettings(store);
    const insert = store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    insert.run('rtk-settings-v1:global', 'TRUE');
    assert.equal(settings.enabled(a.id), false);
    store.rtkSettings.setGlobal(true);
    insert.run(`rtk-settings-v1:project:${JSON.stringify(a.id)}`, 'ON');
    assert.equal(settings.enabled(a.id), false);
    settings.update(a.id, { type: 'project', mode: 'follow' });
    assert.equal(settings.enabled(a.id), true);
    store.skillInheritance.setGlobal(false);
    assert.equal(settings.enabled(a.id), true);
    for (const invalid of [
      {},
      { type: 'global', enabled: 'true' },
      { type: 'project', mode: 'enable' },
      { type: 'global', enabled: true, rtkBinary: '/tmp/untrusted' },
    ]) {
      assert.equal(rtkSettingsPatchSchema.safeParse(invalid).success, false);
    }
  } finally {
    store.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('RTK API validates scope, rejects paths and persists project and global settings across restart', async () => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-rtk-api-'));
  let app = await createApp({ root, data });
  let origin = '';
  let token = '';
  async function connect() {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
    token = z
      .object({ csrfToken: z.string() })
      .parse(await fetch(origin + '/api/bootstrap').then((r) => r.json())).csrfToken;
  }
  async function request(query = '', patch?: unknown, expected = 200) {
    const response = await fetch(origin + endpoint + query, {
      method: patch === undefined ? 'GET' : 'PATCH',
      headers: { 'content-type': 'application/json', 'x-atelier-token': token },
      ...(patch === undefined ? {} : { body: JSON.stringify(patch) }),
    });
    const value: unknown = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return expected === 200 ? rtkSettingsViewSchema.parse(value) : undefined;
  }
  try {
    const a = addProject(app.store, data);
    const b = addProject(app.store, data);
    const queryA = `?projectId=${a.id}`;
    const queryB = `?projectId=${b.id}`;
    await connect();
    assert.deepEqual(await request(), {
      globalEnabled: true,
      projectMode: 'follow',
      effectiveEnabled: true,
      source: 'global',
      available: false,
      unavailableReason: 'native-unavailable',
    });
    await request(queryA, { type: 'project', mode: 'off' });
    assert.equal((await request(queryA))?.effectiveEnabled, false);
    assert.equal((await request(queryB))?.effectiveEnabled, true);
    await request('', { type: 'global', enabled: false });
    await request(queryB, { type: 'project', mode: 'on' });
    for (const [query, patch] of [
      [queryA, { type: 'global', enabled: true }],
      ['', { type: 'project', mode: 'off' }],
      [queryA, { type: 'project', mode: 'off', rtkBinary: '/tmp/untrusted' }],
      ['?projectId=bad', { type: 'project', mode: 'on' }],
      ['?rtkBinary=%2Ftmp%2Funtrusted', { type: 'global', enabled: true }],
    ] as const)
      await request(query, patch, 400);
    await request(`?projectId=${randomUUID()}`, { type: 'project', mode: 'off' }, 404);
    const unauthorized = await fetch(origin + endpoint, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'global', enabled: true }),
    });
    assert.equal(unauthorized.status, 403);
    await app.close();
    app = await createApp({
      root,
      data,
      nativeExecution: true,
      desktopPairing: 'rtk-fixture-pairing',
      rtkBinary: join(data, 'missing-rtk'),
    });
    // The paired runtime requires its existing pairing header for all API reads.
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
    const paired = await fetch(origin + endpoint + queryB, {
      headers: { 'x-atelier-desktop-pairing': 'rtk-fixture-pairing' },
    });
    assert.equal(paired.status, 200);
    const restored = rtkSettingsViewSchema.parse(await paired.json());
    assert.equal(restored.globalEnabled, false);
    assert.equal(restored.projectMode, 'on');
    assert.equal(restored.effectiveEnabled, true);
    assert.equal(restored.available, false);
    assert.equal(
      restored.unavailableReason,
      process.platform === 'linux' ? 'resource-unavailable' : 'native-unavailable',
    );
    assert.equal(new RtkSettings(app.store).enabled(a.id), false);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});
