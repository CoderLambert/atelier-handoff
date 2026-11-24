/**
 * @file 验证独立多提交偏好的严格契约与持久化。
 * @implementation 使用临时 SQLite 和 HTTP 验证完整保存、重启恢复、损坏回退以及聊天和布局设置隔离，不执行 Git 或模型请求。
 * @updated 2026-11-25T00:11:59+08:00
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
import { Store } from '../server/store.js';
import { gitMultiCommitPreferences } from '../shared/git-multi-commit.js';
import { emptyDraft, now, reasoningEfforts } from '../shared/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const endpoint = '/api/settings/git-multi-commit-preferences';
const automatic = { model: null, effort: null };

test('multi-commit preferences require a strict complete object with nullable model and effort', () => {
  assert.deepEqual(gitMultiCommitPreferences.parse(automatic), automatic);
  for (const effort of reasoningEfforts) {
    assert.deepEqual(
      gitMultiCommitPreferences.parse({ model: '  magpie:fixture/manual  ', effort }),
      { model: 'magpie:fixture/manual', effort },
    );
  }
  for (const invalid of [
    {},
    { model: null },
    { effort: null },
    { model: null, effort: null, gateway: 'http://127.0.0.1:1' },
    { model: '', effort: null },
    { model: 'two models', effort: null },
    { model: 'x'.repeat(201), effort: null },
    { model: null, effort: 'auto' },
    { model: null, effort: 42 },
    { preferences: automatic },
  ]) {
    assert.equal(gitMultiCommitPreferences.safeParse(invalid).success, false);
  }
});

test('preferences API fully saves and clears independent settings across SQLite restarts', async () => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-multi-preferences-'));
  let app = await createApp({ root, data });
  let origin = '';
  let csrfToken = '';
  async function connect() {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    origin = `http://127.0.0.1:${address.port}`;
    csrfToken = z
      .object({ csrfToken: z.string() })
      .parse(await fetch(origin + '/api/bootstrap').then((response) => response.json())).csrfToken;
  }
  async function request(method = 'GET', body?: unknown, expected = 200) {
    const response = await fetch(origin + endpoint, {
      method,
      headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  try {
    app.store.setConfig({
      ...app.store.config(),
      gateway: 'http://127.0.0.1:1',
      managedGateway: false,
      model: 'fixture-chat',
      effort: 'high',
    });
    const session = app.store.put('sessions', {
      id: randomUUID(),
      projectId: randomUUID(),
      title: 'Synthetic chat draft',
      status: 'active',
      sdkSessionId: null,
      createdAt: now(),
      updatedAt: now(),
      draft: { ...emptyDraft(), model: 'fixture-draft', effort: 'low', text: 'Keep this draft' },
    });
    const config = app.store.config();
    const layout = app.store.workspaceLayout.read();
    const version = app.store.db.prepare('PRAGMA user_version').get();
    await connect();
    assert.deepEqual(await request(), automatic);
    const saved = { model: 'magpie:fixture/manual', effort: 'xhigh' };
    assert.deepEqual(await request('PATCH', saved), saved);
    assert.deepEqual(await request(), saved);
    for (const invalid of [
      { model: null },
      { effort: null },
      { ...saved, effort: 'auto' },
      { ...saved, extra: true },
      { preferences: saved },
    ]) {
      await request('PATCH', invalid, 400);
      assert.deepEqual(await request(), saved, 'invalid writes preserve the full saved object');
    }
    assert.deepEqual(app.store.config(), config);
    assert.deepEqual(app.store.get('sessions', session.id), session);
    assert.deepEqual(app.store.workspaceLayout.read(), layout);
    assert.deepEqual(app.store.db.prepare('PRAGMA user_version').get(), version);
    await app.close();
    app = await createApp({ root, data });
    await connect();
    assert.deepEqual(await request(), saved);
    assert.deepEqual(app.store.config(), config);
    assert.deepEqual(app.store.get('sessions', session.id), session);
    assert.deepEqual(app.store.workspaceLayout.read(), layout);
    assert.deepEqual(app.store.db.prepare('PRAGMA user_version').get(), version);
    for (const preferences of [
      { model: null, effort: 'max' },
      { model: 'fixture/manual', effort: null },
      automatic,
    ]) {
      assert.deepEqual(await request('PATCH', preferences), preferences);
      assert.deepEqual(await request(), preferences);
    }
    await app.close();
    app = await createApp({ root, data });
    await connect();
    assert.deepEqual(await request(), automatic);
    assert.deepEqual(app.store.config(), config);
    assert.deepEqual(app.store.get('sessions', session.id), session);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('missing or corrupted persisted preferences fall back to fresh automatic values', async () => {
  const data = await mkdtemp(join(tmpdir(), 'atelier-multi-preferences-corrupt-'));
  const store = new Store(data);
  try {
    const first = store.gitMultiCommitPreferences.read();
    first.model = 'client-mutation';
    assert.deepEqual(store.gitMultiCommitPreferences.read(), automatic);
    store.gitMultiCommitPreferences.save({ model: 'fixture', effort: 'medium' });
    for (const value of [
      'invalid-json',
      JSON.stringify({ model: 'fixture' }),
      JSON.stringify({ model: null, effort: 'auto' }),
      JSON.stringify({ ...automatic, extra: true }),
    ]) {
      store.db
        .prepare('UPDATE settings SET value=? WHERE key=?')
        .run(value, 'git-multi-commit-preferences-v1');
      assert.deepEqual(store.gitMultiCommitPreferences.read(), automatic);
    }
    assert.throws(() =>
      store.gitMultiCommitPreferences.save({ model: 'invalid model', effort: null }),
    );
  } finally {
    store.db.close();
    await rm(data, { recursive: true, force: true });
  }
});
