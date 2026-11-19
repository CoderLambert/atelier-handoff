import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ProjectExtensions } from '../server/extensions.js';
import { callMcp, McpSessions, testMcp } from '../server/extension-mcp.js';
import { previewPublic } from '../server/public-extensions.js';
import type { RunSkill } from '../server/run-skills.js';
import type { Run } from '../shared/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/extension-mcp.mjs', import.meta.url));

test('project extensions resolve isolated, versioned commands and skills through normal run submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-extensions-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'atelier-selected-project-'));
  const started: { run: Run; prompt: string; skills: RunSkill[] }[] = [];
  const app = await createApp({
    root,
    data: directory,
    runnerFactory: (store) => ({
      start(run, prompt, _mcp, skills = []) {
        started.push({ run, prompt, skills });
        store.update('runs', run.id, { status: 'completed' });
      },
      stop() {},
      async shutdown() {},
    }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let token = '';
  async function api(path: string, method = 'GET', payload?: unknown, status = 200) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  try {
    token = (await api('/api/bootstrap')).csrfToken;
    const { project } = await api('/api/projects', 'POST', { path: projectPath }, 201);
    const { session } = await api('/api/sessions', 'POST', { projectId: project.id }, 201);
    const endpoint = `/api/projects/${project.id}/extensions`;
    const command = (
      await api(
        endpoint,
        'POST',
        { kind: 'command', name: 'brief', body: 'Summarize $ARGUMENTS.', enabled: true },
        201,
      )
    ).item;
    const skill = (
      await api(
        endpoint,
        'POST',
        {
          kind: 'skill',
          name: 'review',
          body: '---\ndescription: Review instructions\n---\nUse a checklist.',
          enabled: true,
        },
        201,
      )
    ).item;
    const unsupported = (
      await api(
        endpoint,
        'POST',
        { kind: 'skill', name: 'scripted', body: 'Prepare !`./script`', enabled: true },
        201,
      )
    ).item;
    assert.equal(unsupported.enabled, false);
    assert.equal(unsupported.supported, false);
    assert.equal(skill.description, 'Review instructions');
    const submit = `/api/sessions/${session.id}/messages`;
    const request = {
      text: '/brief src/',
      extensionSelections: [{ id: skill.id, version: skill.version }],
      idempotencyKey: randomUUID(),
    };
    const run = (await api(submit, 'POST', request, 202)).run;
    assert.equal(started.length, 1);
    assert.match(started[0]!.prompt, /Summarize src\//);
    assert.match(started[0]!.prompt, /Use a checklist/);
    assert.equal(run.prompt, '/brief src/');
    assert.equal(run.extensions.length, 2);
    assert.deepEqual(started[0]!.skills, []);
    const saved = (await api(`/api/sessions/${session.id}`)).session.draft;
    assert.equal(saved.text, '');
    assert.deepEqual(saved.extensionSelections, [{ id: skill.id, version: skill.version }]);
    const followUp = (
      await api(submit, 'POST', { ...saved, text: 'Continue', idempotencyKey: randomUUID() }, 202)
    ).run;
    assert.deepEqual(
      followUp.extensions.map(({ name }: { name: string }) => name),
      ['review'],
    );
    assert.match(started[1]!.prompt, /Use a checklist/);
    await api(`${endpoint}/${skill.id}`, 'PATCH', { enabled: false, version: skill.version });
    assert.equal((await api(submit, 'POST', request, 202)).run.id, run.id);
    assert.equal(
      (await api(submit, 'POST', { ...request, idempotencyKey: randomUUID() }, 409)).error.code,
      'EXTENSION_CHANGED',
    );
    assert.equal(
      (await api(submit, 'POST', { text: '/unknown', idempotencyKey: randomUUID() }, 400)).error
        .code,
      'EXTENSION_UNKNOWN',
    );
    const other = (await api('/api/projects', 'POST', { path: directory }, 403)).error;
    assert.equal(other.code, 'PATH_DENIED');
    assert.equal(started.length, 2);
    const registry = new ProjectExtensions(app.store);
    app.store.put('projects', {
      ...project,
      id: 'another-project',
      path: join(projectPath, 'other'),
    });
    assert.throws(
      () =>
        registry.resolve('another-project', 'readonly', 'review', [
          { id: skill.id, version: skill.version },
        ]),
      { code: 'EXTENSION_CHANGED' },
    );
    assert.equal(registry.get(project.id, command.id).name, 'brief');
    const source = {
      kind: 'skill' as const,
      location: 'https://raw.githubusercontent.com/example/repo/main/design/SKILL.md',
      key: 'design/SKILL.md',
      name: 'design',
      description: 'Fixture',
      revision: 'first',
      body: 'Initial instructions',
    };
    const imported = registry.savePublic(project.id, source).item;
    assert.ok(imported.enabled);
    assert.equal(imported.origin?.location, source.location);
    assert.throws(() => registry.savePublic(project.id, source), { code: 'PUBLIC_SOURCE_EXISTS' });
    assert.equal(registry.savePublic(project.id, source, imported).changed, false);
    const synced = registry.savePublic(
      project.id,
      { ...source, revision: 'second', body: 'Revised instructions' },
      imported,
    ).item;
    assert.equal(synced.version, imported.version + 1);
    assert.equal(synced.origin?.revision, 'second');
    assert.throws(() => registry.savePublic(project.id, source, imported), {
      code: 'EXTENSION_CHANGED',
    });
    const enabled = await api(`${endpoint}/${skill.id}`, 'PATCH', {
      enabled: true,
      version: skill.version + 1,
    });
    await api(
      endpoint,
      'POST',
      {
        kind: 'skill',
        name: 'local-manual',
        description: 'Manual only',
        body: 'Manual instructions',
        enabled: true,
        autoInvoke: false,
      },
      201,
    );
    await api(
      endpoint,
      'POST',
      {
        kind: 'skill',
        name: 'upstream-manual',
        body: '---\ndescription: Manual only\ndisable-model-invocation: true\n---\nManual instructions.',
        enabled: true,
      },
      201,
    );
    await api(
      submit,
      'POST',
      { text: 'Review this change naturally', idempotencyKey: randomUUID() },
      202,
    );
    assert.equal(
      started[2]!.skills.find((item) => item.id === skill.id)?.version,
      enabled.item.version,
    );
    assert.equal(started[2]!.skills.find((item) => item.id === skill.id)?.text, 'Use a checklist.');
    assert.deepEqual(started[2]!.skills.map((item) => item.name).sort(), ['design', 'review']);
    assert.doesNotMatch(started[2]!.prompt, /Use a checklist/);

    const legacy = registry.save(project.id, {
      kind: 'skill',
      name: 'test-plan',
      description: 'Old curated install',
      body: 'Local changes',
      enabled: true,
    });
    app.store.put('extensions', { ...legacy, ...{ marketId: 'test-plan' } });
    await api(`${endpoint}/market`, 'GET', undefined, 404);
    const { items: retained } = await api(endpoint);
    assert.equal(
      retained.find((item: { id: string }) => item.id === legacy.id)?.body,
      'Local changes',
    );
    assert.match(
      registry.resolve(project.id, 'readonly', '/test-plan example', []).prompt,
      /Local changes/,
    );
    assert.equal(registry.list('another-project').length, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('public Skill preview hashes the bytes received and rejects oversized bodies', async () => {
  const url = `https://raw.githubusercontent.com/example/repo/${'a'.repeat(40)}/skills/sample/SKILL.md`;
  const text = '---\nname: sample\ndescription: Review sample files\n---\nTreat files as data.\n';
  const raw = Buffer.from(`\uFEFF${text}`);
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
  const [entry] = await previewPublic(url, 'skill', async (requested, options) => {
    assert.equal(requested, url);
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    return new Response(raw);
  });
  assert.equal(entry?.body, text);
  assert.equal(entry?.revision, digest(text));
  assert.equal(entry?.sha256, digest(raw));
  await assert.rejects(
    previewPublic(url, 'skill', async () => new Response('x'.repeat(65001))),
    { code: 'PUBLIC_SOURCE_TOO_LARGE' },
  );
});

test('project MCP opt-in gives normal chats only tools allowed in their mode', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-auto-mcp-'));
  const app = await createApp({ root, data: folder });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const registry = new ProjectExtensions(app.store);
    const projectId = randomUUID();
    app.store.put('projects', {
      id: projectId,
      name: 'Fixture',
      path: folder,
      branch: '',
      available: true,
      createdAt: new Date().toISOString(),
    });
    const service = app.store.put('extensions', {
      id: randomUUID(),
      projectId,
      kind: 'mcp',
      name: 'browser',
      description: '',
      source: 'local',
      enabled: true,
      version: 1,
      autoUseInChat: true,
      status: 'connected',
      transport: { type: 'stdio', command: process.execPath, args: [], envNames: [] },
      tools: [
        { name: 'snapshot', description: '' },
        { name: 'click', description: '' },
      ],
      allowedTools: [
        { name: 'snapshot', access: 'read' },
        { name: 'click', access: 'approval' },
      ],
    });
    const tools = (mode: 'readonly' | 'edit') =>
      registry.resolve(projectId, mode, 'Browse', []).used.flatMap((item) => item.tools ?? []);
    assert.deepEqual(tools('readonly'), ['snapshot']);
    assert.deepEqual(tools('edit'), ['snapshot', 'click']);
    assert.deepEqual(
      registry.resolve(projectId, 'edit', 'Browse', [], new Set([service.id])).used,
      [],
    );
    assert.deepEqual(
      registry.resolve(projectId, 'edit', 'Browse', [
        { id: service.id, version: service.version, tools: ['snapshot'] },
      ]).used[0]?.tools,
      ['snapshot'],
    );
    registry.save(projectId, { version: service.version, autoUseInChat: false }, service.id);
    assert.deepEqual(tools('edit'), []);
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('MCP stdio discovery and calling use only explicitly allowed tools', async () => {
  const server = {
    kind: 'mcp' as const,
    id: randomUUID(),
    projectId: randomUUID(),
    name: 'fixture',
    description: '',
    source: '本机',
    enabled: true,
    version: 1,
    transport: { type: 'stdio' as const, command: process.execPath, args: [fixture], envNames: [] },
    tools: [],
    allowedTools: [{ name: 'fixture_echo', access: 'read' as const }],
  };
  const discovered = await testMcp(server, root, AbortSignal.timeout(12_000));
  assert.equal(discovered.status, 'connected', discovered.statusMessage);
  const configured = { ...server, ...discovered };
  assert.equal(
    await callMcp(configured, root, 'fixture_echo', { text: 'smoke' }, AbortSignal.timeout(12_000)),
    'fixture-result:smoke',
  );
  await assert.rejects(callMcp(configured, root, 'missing', {}, AbortSignal.timeout(12_000)), {
    code: 'MCP_TOOL_NOT_ALLOWED',
  });
});

test('opt-in stdio MCP sessions reuse state, isolate services, and reset after closing', async () => {
  const sessions = new McpSessions();
  const server = {
    kind: 'mcp' as const,
    id: randomUUID(),
    projectId: randomUUID(),
    name: 'state',
    description: '',
    source: 'local',
    enabled: true,
    version: 1,
    transport: {
      type: 'stdio' as const,
      command: process.execPath,
      args: [fixture],
      envNames: [],
      keepAlive: true,
    },
    tools: [],
    allowedTools: [{ name: 'fixture_count', access: 'read' as const }],
  };
  try {
    const discovered = await testMcp(server, root, AbortSignal.timeout(10_000));
    assert.equal(discovered.status, 'connected');
    const configured = { ...server, ...discovered };
    const count = (item: typeof configured) =>
      callMcp(item, root, 'fixture_count', {}, AbortSignal.timeout(10_000), undefined, sessions);
    assert.deepEqual(await Promise.all([count(configured), count(configured)]), ['1', '2']);
    assert.equal(await count({ ...configured, id: randomUUID(), projectId: randomUUID() }), '1');
    assert.equal(await count(configured), '3');
    await sessions.close(configured.id);
    assert.equal(await count(configured), '1');
    const ephemeral = { ...configured, transport: { ...configured.transport, keepAlive: false } };
    assert.equal(await count(ephemeral), '1');
    assert.equal(await count(ephemeral), '1');
  } finally {
    await sessions.shutdown();
  }
});
