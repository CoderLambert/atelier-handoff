import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ProjectExtensions } from '../server/extensions.js';
import { callMcp, testMcp } from '../server/extension-mcp.js';
import type { Run } from '../shared/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/extension-mcp.mjs', import.meta.url));

test('project extensions resolve isolated, versioned commands and skills through normal run submission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-extensions-'));
  const projectPath = await mkdtemp(join(tmpdir(), 'atelier-selected-project-'));
  const started: { run: Run; prompt: string }[] = [];
  const app = await createApp({ root, data: directory, runnerFactory: store => ({
    start(run, prompt) { started.push({ run, prompt }); store.update('runs', run.id, { status: 'completed' }); },
    stop() {}, async shutdown() {},
  }) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let token = '';
  async function api(path: string, method = 'GET', payload?: unknown, status = 200) {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  try {
    token = (await api('/api/bootstrap')).csrfToken;
    const { project } = await api('/api/projects', 'POST', { path: projectPath }, 201);
    const { session } = await api('/api/sessions', 'POST', { projectId: project.id }, 201);
    const endpoint = `/api/projects/${project.id}/extensions`;
    const command = (await api(endpoint, 'POST', { kind: 'command', name: 'brief', body: 'Summarize $ARGUMENTS.', enabled: true }, 201)).item;
    const skill = (await api(endpoint, 'POST', { kind: 'skill', name: 'review', body: '---\ndescription: Review instructions\n---\nUse a checklist.', enabled: true }, 201)).item;
    const unsupported = (await api(endpoint, 'POST', { kind: 'skill', name: 'scripted', body: 'Prepare !`./script`', enabled: true }, 201)).item;
    assert.equal(unsupported.enabled, false);
    assert.equal(unsupported.supported, false);
    assert.equal(skill.description, 'Review instructions');
    const submit = `/api/sessions/${session.id}/messages`;
    const request = { text: '/brief src/', extensionSelections: [{ id: skill.id, version: skill.version }], idempotencyKey: randomUUID() };
    const run = (await api(submit, 'POST', request, 202)).run;
    assert.equal(started.length, 1);
    assert.match(started[0]!.prompt, /Summarize src\//);
    assert.match(started[0]!.prompt, /Use a checklist/);
    assert.equal(run.prompt, '/brief src/');
    assert.equal(run.extensions.length, 2);
    await api(`${endpoint}/${skill.id}`, 'PATCH', { enabled: false, version: skill.version });
    assert.equal((await api(submit, 'POST', request, 202)).run.id, run.id);
    assert.equal((await api(submit, 'POST', { ...request, idempotencyKey: randomUUID() }, 409)).error.code, 'EXTENSION_CHANGED');
    assert.equal((await api(submit, 'POST', { text: '/unknown', idempotencyKey: randomUUID() }, 400)).error.code, 'EXTENSION_UNKNOWN');
    const other = (await api('/api/projects', 'POST', { path: directory }, 403)).error;
    assert.equal(other.code, 'PATH_DENIED');
    assert.equal(started.length, 1);
    const registry = new ProjectExtensions(app.store);
    app.store.put('projects', { ...project, id: 'another-project', path: join(projectPath, 'other') });
    assert.throws(() => registry.resolve('another-project', 'readonly', 'review', [{ id: skill.id, version: skill.version }]), { code: 'EXTENSION_CHANGED' });
    assert.equal(registry.get(project.id, command.id).name, 'brief');
    const source = { kind: 'skill' as const, location: 'https://raw.githubusercontent.com/example/repo/main/design/SKILL.md', key: 'design/SKILL.md', name: 'design', description: 'Fixture', revision: 'first', body: 'Initial instructions' };
    const imported = registry.savePublic(project.id, source).item;
    assert.ok(imported.enabled);
    assert.equal(imported.origin?.location, source.location);
    assert.throws(() => registry.savePublic(project.id, source), { code: 'PUBLIC_SOURCE_EXISTS' });
    assert.equal(registry.savePublic(project.id, source, imported).changed, false);
    const synced = registry.savePublic(project.id, { ...source, revision: 'second', body: 'Revised instructions' }, imported).item;
    assert.equal(synced.version, imported.version + 1);
    assert.equal(synced.origin?.revision, 'second');
    assert.throws(() => registry.savePublic(project.id, source, imported), { code: 'EXTENSION_CHANGED' });
    const market = `${endpoint}/market`;
    assert.equal((await api(market)).items.find((item: {id: string}) => item.id === 'test-plan').status, 'available');
    const installed = (await api(market, 'POST', { id: 'test-plan' })).item;
    assert.equal(installed.enabled, true);
    assert.equal((await api(market, 'POST', { id: 'test-plan' })).item.id, installed.id);
    const disabled = (await api(`${endpoint}/${installed.id}`, 'PATCH', { version: installed.version, enabled: false, body: 'Local changes' })).item;
    assert.equal(disabled.enabled, false);
    const activated = (await api(market, 'POST', { id: 'test-plan' })).item;
    assert.equal(activated.id, installed.id);
    assert.equal(activated.body, 'Local changes');
    assert.equal(activated.enabled, true);
    assert.equal((await api(market)).items.find((item: {id: string}) => item.id === 'test-plan').status, 'enabled');
    assert.equal(registry.list('another-project').length, 0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('MCP stdio discovery and calling use only explicitly allowed tools', async () => {
  const server = {
    kind: 'mcp' as const, id: randomUUID(), projectId: randomUUID(), name: 'fixture', description: '', source: '本机', enabled: true, version: 1,
    transport: { type: 'stdio' as const, command: process.execPath, args: [fixture], envNames: [] },
    tools: [], allowedTools: [{ name: 'fixture_echo', access: 'read' as const }],
  };
  const discovered = await testMcp(server, root, AbortSignal.timeout(12_000));
  assert.equal(discovered.status, 'connected', discovered.statusMessage);
  const configured = { ...server, ...discovered };
  assert.equal(await callMcp(configured, root, 'fixture_echo', { text: 'smoke' }, AbortSignal.timeout(12_000)), 'fixture-result:smoke');
  await assert.rejects(callMcp(configured, root, 'missing', {}, AbortSignal.timeout(12_000)), { code: 'MCP_TOOL_NOT_ALLOWED' });
});
