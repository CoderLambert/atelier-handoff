import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectExtensions } from '../server/extensions.js';
import {
  httpBindingUrl,
  readSkillToolBindings,
  saveSkillToolBindings,
} from '../server/skill-tool-bindings.js';
import { Store } from '../server/store.js';

const forecast = {
  kind: 'http',
  name: 'forecast',
  url: 'https://wttr.in/{location}?format=j1',
  parameter: 'location',
  description: 'Weather forecast',
} as const;

test('Skill HTTP templates keep the configured origin and encode one input', () => {
  assert.equal(httpBindingUrl(forecast, 'New York').href, 'https://wttr.in/New%20York?format=j1');
  const url = httpBindingUrl({ ...forecast, url: 'https://example.net/v1?limit=1' }, 'a&limit=2');
  assert.equal(url.searchParams.get('limit'), '1');
  assert.equal(url.searchParams.get('location'), 'a&limit=2');
  for (const value of ['..', 'a/b', '%2F', 'a\\b'])
    assert.throws(() => httpBindingUrl(forecast, value));
  for (const url of [
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'http://example.net/x',
    'https://user:pw@example.net/x',
    'https://example.net:8443/x',
  ])
    assert.throws(() => httpBindingUrl({ ...forecast, url }, 'test'));
});

test('Skill bindings persist per project and reject ungranted MCP tools', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'atelier-tool-bindings-'));
  const store = new Store(folder);
  try {
    const project = store.put('projects', {
      id: randomUUID(),
      name: 'Test',
      path: folder,
      branch: '',
      available: true,
      createdAt: new Date().toISOString(),
    });
    const skill = new ProjectExtensions(store).save(project.id, {
      kind: 'skill',
      name: 'forecast',
      enabled: true,
      body: '# Forecast',
    });
    const service = store.put('extensions', {
      id: randomUUID(),
      projectId: project.id,
      kind: 'mcp',
      name: 'fixture',
      description: '',
      source: 'local',
      enabled: true,
      version: 1,
      transport: { type: 'stdio', command: 'fixture', args: [], envNames: [] },
      tools: [{ name: 'query', description: '', inputSchema: {} }],
      allowedTools: [],
    });
    const mcp = { kind: 'mcp', name: 'query', extensionId: service.id, tool: 'query' };
    assert.throws(() => saveSkillToolBindings(store, project.id, skill.id, { bindings: [mcp] }), {
      code: 'MCP_TOOL_NOT_ALLOWED',
    });
    store.update('extensions', service.id, { allowedTools: [{ name: 'query', access: 'read' }] });
    assert.deepEqual(
      saveSkillToolBindings(store, project.id, skill.id, { bindings: [forecast, mcp] }),
      [forecast, mcp],
    );
    assert.deepEqual(readSkillToolBindings(store, project.id, skill.id), [forecast, mcp]);
    assert.throws(() => saveSkillToolBindings(store, randomUUID(), skill.id, { bindings: [] }), {
      code: 'NOT_FOUND',
    });
    saveSkillToolBindings(store, project.id, skill.id, { bindings: [] });
    assert.deepEqual(readSkillToolBindings(store, project.id, skill.id), []);
  } finally {
    store.close();
    await rm(folder, { recursive: true, force: true });
  }
});
