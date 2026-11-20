/**
 * @file 验证桌面项目的浏览器授权与失效审批。
 * @implementation 使用隔离 SQLite 验证启用、撤销、版本竞争和旧扩展的桌面与 Web 解析。
 * @updated 2026-11-20T12:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopBrowserAccess } from '../server/desktop-browser-access.js';
import { ProjectExtensions } from '../server/extensions.js';
import { PermissionService } from '../server/permissions.js';
import { Store } from '../server/store.js';
import { now, type Run } from '../shared/types.js';

async function workspace(
  run: (store: Store, directory: string, projectId: string) => void | Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-browser-access-'));
  const store = new Store(directory);
  const project = store.put('projects', {
    id: randomUUID(),
    name: 'Browser fixture',
    path: directory,
    branch: '',
    createdAt: now(),
    available: true,
  });
  try {
    await run(store, directory, project.id);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('browser access is versioned per project and revokes a pending browser approval', async () => {
  await workspace(async (store, directory, projectId) => {
    const other = store.put('projects', {
      id: randomUUID(),
      name: 'Other fixture',
      path: join(directory, 'other'),
      branch: '',
      createdAt: now(),
      available: true,
    });
    const access = new DesktopBrowserAccess(store, () => true);
    assert.deepEqual(access.read(projectId), { available: true, enabled: false, revision: null });
    const enabled = access.update(projectId, { enabled: true, revision: null });
    const originalRevision = enabled.revision;
    assert.ok(originalRevision);
    const signal = access.signal(projectId, originalRevision);
    assert.equal(access.read(other.id).enabled, false);
    assert.throws(() => access.update(projectId, { enabled: false, revision: null }), {
      code: 'BROWSER_ACCESS_CHANGED',
    });

    const run: Run = {
      id: randomUUID(),
      projectId,
      sessionId: randomUUID(),
      prompt: 'Browser fixture',
      mode: 'edit',
      status: 'running',
      createdAt: now(),
      startedAt: now(),
      endedAt: null,
      reason: null,
      error: null,
      retryOf: null,
      contextPaths: [],
      attachmentIds: [],
      plan: [],
      usage: null,
      config: store.config(),
      browserRevision: originalRevision,
    };
    store.put('runs', run);
    const tool = store.put('tools', {
      id: randomUUID(),
      name: 'browser_click',
      runId: run.id,
      sessionId: run.sessionId,
      status: 'running',
      startedAt: now(),
      endedAt: null,
      inputSummary: '',
      output: '',
    });
    const permissions = new PermissionService(store);
    const approval = permissions.request(
      run,
      directory,
      {
        toolCallId: tool.id,
        kind: 'browser',
        command: 'browser_click {"ref":"r1-1"}',
        reason: 'fixture',
      },
      signal,
    );
    const rejected = assert.rejects(approval, { code: 'BROWSER_ACCESS_DENIED' });
    const pending = store.list('permissions')[0];
    assert.ok(pending);
    assert.equal(pending.status, 'pending');
    const disabled = access.update(projectId, { enabled: false, revision: enabled.revision });
    await rejected;
    assert.equal(store.get('permissions', pending.id).status, 'canceled');
    await assert.rejects(permissions.decide(pending.id, 'allow', pending.version), {
      code: 'PERMISSION_EXPIRED',
    });
    const enabledAgain = access.update(projectId, { enabled: true, revision: disabled.revision });
    assert.notEqual(enabledAgain.revision, enabled.revision);
    assert.throws(() => access.signal(projectId, originalRevision), {
      code: 'BROWSER_ACCESS_DENIED',
    });
    const web = new DesktopBrowserAccess(store, () => false);
    assert.throws(
      () => web.update(projectId, { enabled: false, revision: enabledAgain.revision }),
      { code: 'DESKTOP_BROWSER_UNAVAILABLE' },
    );
  });
});

test('desktop skips legacy browser automation without disabling the Web configuration', async () => {
  await workspace((store, _directory, projectId) => {
    const desktop = new ProjectExtensions(store, true);
    const previous = desktop.save(projectId, {
      kind: 'mcp',
      name: 'playwright',
      description: '',
      enabled: true,
      autoUseInChat: true,
      transport: {
        type: 'stdio',
        command: '/usr/bin/node',
        args: ['/fixture/node_modules/@playwright/mcp/cli.js'],
        envNames: [],
      },
    });
    assert.equal(previous.kind, 'mcp');
    const updated = desktop.recordTest(previous, {
      status: 'connected',
      statusMessage: 'fixture',
      tools: [{ name: 'browser_snapshot', description: 'fixture' }],
    });
    const selected = desktop.save(
      projectId,
      { version: updated.version, allowedTools: [{ name: 'browser_snapshot', access: 'read' }] },
      updated.id,
    );
    assert.deepEqual(desktop.resolve(projectId, 'readonly', 'observe', []).mcp, []);
    assert.throws(
      () =>
        desktop.resolve(projectId, 'readonly', 'observe', [
          { id: selected.id, version: selected.version },
        ]),
      { code: 'LEGACY_BROWSER_UNAVAILABLE' },
    );
    assert.equal(
      new ProjectExtensions(store).resolve(projectId, 'readonly', 'observe', []).mcp[0]?.id,
      selected.id,
    );
  });
});
