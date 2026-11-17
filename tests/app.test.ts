import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { PermissionService } from '../server/permissions.js';
import { applyText, readProjectText } from '../server/files.js';
import { commandsAvailable, runCommand } from '../server/commands.js';
import { now, type Run } from '../shared/types.js';

const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(work: (base: string, project: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-app-test-')); const project = join(base, 'project'); await mkdir(project);
  await writeFile(join(project, 'note.txt'), 'ORIGINAL\n');
  try { await work(base, project); } finally { await rm(base, { recursive: true, force: true }); }
}
function runData(sessionId = 'session', projectId = 'project'): Run {
  return { id: randomUUID(), sessionId, projectId, prompt: 'test', mode: 'edit', status: 'running', createdAt: now(), startedAt: now(), endedAt: null, reason: null, error: null, retryOf: null, contextPaths: [], attachmentIds: [], plan: [], usage: null, config: { gateway: 'http://127.0.0.1:3001', model: 'test-only', maxTurns: 4, timeoutMs: 10000 } };
}

test('real HTTP and SQLite: projects, isolated drafts, idempotent runs, uploads, immutable artifacts and history', async () => fixture(async (base, project) => {
  let starts = 0;
  const app = await createApp({ root: source, data: join(base, 'data'), runnerFactory: store => ({
    start(run) { starts++; store.update('runs', run.id, { status: 'running' }); },
    stop(id) { store.update('runs', id, { status: 'stopped', endedAt: now() }); },
    async shutdown() {},
  }) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let token = '';
  const request = async (route: string, method = 'GET', body?: unknown, expected = 200) => {
    const response = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  try {
    token = (await request('/api/bootstrap')).csrfToken;
    const denied = await fetch(url + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: project }) }); assert.equal(denied.status, 403);
    const origin = await fetch(url + '/api/bootstrap', { headers: { Origin: 'https://example.com' } }); assert.equal(origin.status, 403);
    const p = (await request('/api/projects', 'POST', { path: project }, 201)).project;
    const s1 = (await request('/api/sessions', 'POST', { projectId: p.id }, 201)).session;
    const s2 = (await request('/api/sessions', 'POST', { projectId: p.id }, 201)).session;
    await request(`/api/sessions/${s1.id}`, 'PATCH', { draft: { text: 'draft one', contextPaths: ['note.txt'], attachmentIds: [], mode: 'readonly' } });
    assert.equal((await request(`/api/sessions/${s2.id}`)).session.draft.text, '');
    const attachment = (await request(`/api/sessions/${s1.id}/attachments`, 'POST', { name: 'notes.md', contentBase64: Buffer.from('attached content').toString('base64') }, 201)).attachment;
    await request(`/api/sessions/${s2.id}`, 'PATCH', { draft: { text: '', contextPaths: [], attachmentIds: [attachment.id], mode: 'readonly' } }, 403);
    const message = { text: 'Read note', mode: 'readonly', attachmentIds: [attachment.id], contextPaths: ['note.txt'], idempotencyKey: randomUUID() };
    const run = (await request(`/api/sessions/${s1.id}/messages`, 'POST', message, 202)).run;
    assert.equal((await request(`/api/sessions/${s1.id}/messages`, 'POST', message, 202)).run.id, run.id); assert.equal(starts, 1);
    await request(`/api/sessions/${s1.id}/messages`, 'POST', { ...message, text: 'different' }, 409);
    await request(`/api/sessions/${s2.id}/messages`, 'POST', { text: 'conflicting run', idempotencyKey: randomUUID() }, 409);
    await request(`/api/sessions/${s1.id}`, 'DELETE', {}, 409);
    const longOutput = 'long-output '.repeat(3000) + 'END'; const toolId = run.id + ':large-output';
    app.store.put('tools', { id: toolId, runId: run.id, sessionId: s1.id, name: 'test-output', inputSummary: '', status: 'succeeded', output: longOutput.slice(0, 32000), outputLength: longOutput.length, outputTruncated: true, startedAt: now(), endedAt: now() });
    app.files.saveOutput(toolId, longOutput);
    const firstPage = await request(`/api/tools/${encodeURIComponent(toolId)}/output`); assert.equal(firstPage.text, longOutput.slice(0, 16000)); assert.equal(firstPage.nextOffset, 16000);
    const rest = await request(`/api/tools/${encodeURIComponent(toolId)}/output?offset=16000&limit=32000`); assert.equal(firstPage.text + rest.text, longOutput);
    assert.equal(await (await fetch(url + `/api/tools/${encodeURIComponent(toolId)}/output?download=1`)).text(), longOutput);
    const artifact = await app.files.publish(app.store.get('runs', run.id), 'report.md', 'version one');
    await writeFile(join(project, 'report.md'), 'unrelated version');
    assert.equal((await request(`/api/artifacts/${artifact.id}/content`)).text, 'version one');
    await request(`/api/runs/${run.id}/stop`, 'POST', {});
    const retry = (await request(`/api/runs/${run.id}/retry`, 'POST', { idempotencyKey: randomUUID() }, 202)).run;
    assert.notEqual(retry.id, run.id); assert.equal(retry.mode, 'readonly'); assert.equal(retry.retryOf, run.id);
    await request(`/api/runs/${retry.id}/stop`, 'POST', {});
    const snapshot = await request(`/api/sessions/${s1.id}`); assert.equal(snapshot.runs.length, 2); assert.equal(snapshot.messages.length, 2); assert.equal(snapshot.artifacts.length, 1);
    const cursor = app.store.cursor(); const event = app.store.event(run.id, s1.id, 'test.changed', {}); assert.equal(app.store.since(cursor)[0]?.id, event.id);
    const controller = new AbortController(); const stream = await fetch(url + `/api/events?after=${cursor}`, { signal: controller.signal }); const reader = stream.body!.getReader();
    let received = ''; while (!received.includes('test.changed')) received += new TextDecoder().decode((await reader.read()).value); controller.abort();
    await request(`/api/sessions/${s1.id}`, 'PATCH', { title: 'Renamed', status: 'archived' });
    assert.equal((await request('/api/sessions?includeArchived=true')).items.find((s: { id: string }) => s.id === s1.id).title, 'Renamed');
    await request(`/api/sessions/${s1.id}`, 'PATCH', { status: 'active' });
    await request(`/api/sessions/${s1.id}`, 'DELETE', {});
    assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'ORIGINAL\n');
    await request(`/api/artifacts/${artifact.id}/content`, 'GET', undefined, 404);
  } finally { await app.close(); }
}));

test('approval baseline change, duplicate decisions and cancel race cannot apply stale writes', async () => fixture(async (base, project) => {
  const store = new Store(join(base, 'data')); const service = new PermissionService(store, 1000);
  const prepare = () => {
    const run = runData(); store.put('runs', run);
    store.put('tools', { id: run.id, runId: run.id, sessionId: run.sessionId, name: 'edit_file', inputSummary: '', status: 'running', output: '', startedAt: now(), endedAt: null }); return run;
  };
  try {
    let run = prepare(); let controller = new AbortController();
    let pending = service.request(run, project, { toolCallId: run.id, kind: 'edit', path: 'note.txt', before: 'ORIGINAL\n', after: 'APPROVED\n', reason: 'test' }, controller.signal);
    const rejected = assert.rejects(pending, /拒绝/);
    const permission = store.list('permissions').find(p => p.runId === run.id)!;
    await writeFile(join(project, 'note.txt'), 'EXTERNAL CHANGE\n');
    await assert.rejects(service.decide(permission.id, 'allow', permission.version), /文件内容已变化/); await rejected;
    assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'EXTERNAL CHANGE\n');
    await writeFile(join(project, 'note.txt'), 'ORIGINAL\n'); run = prepare(); controller = new AbortController();
    pending = service.request(run, project, { toolCallId: run.id, kind: 'edit', path: 'note.txt', before: 'ORIGINAL\n', after: 'APPROVED\n', reason: 'test' }, controller.signal);
    const p2 = store.list('permissions').find(p => p.runId === run.id)!;
    const results = await Promise.all([service.decide(p2.id, 'allow', p2.version), service.decide(p2.id, 'allow', p2.version)]); assert.ok(results.every(p => p.status === 'allowed')); await pending;
    await applyText(project, 'note.txt', 'ORIGINAL\n', 'APPROVED\n', controller.signal);
    await assert.rejects(applyText(project, 'note.txt', 'ORIGINAL\n', 'APPROVED\n', controller.signal), /变化/);
    run = prepare(); controller = new AbortController();
    pending = service.request(run, project, { toolCallId: run.id, kind: 'delete', path: 'note.txt', before: 'APPROVED\n', after: null, reason: 'test' }, controller.signal);
    const canceled = assert.rejects(pending); const p3 = store.list('permissions').find(p => p.runId === run.id)!;
    store.update('runs', run.id, { status: 'stopping' }); controller.abort(); await canceled;
    await assert.rejects(service.decide(p3.id, 'allow', p3.version), /取消|过期/);
    assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'APPROVED\n');
  } finally { store.close(); }
}));

test('restart persists distinct runs and invalidates ordinary pending approvals', async () => fixture(async (base) => {
  const directory = join(base, 'data'); let store = new Store(directory); const run = runData(); store.put('runs', run);
  store.put('messages', { id: 'message', sessionId: run.sessionId, runId: run.id, role: 'user', text: 'preserved', createdAt: now() });
  store.put('permissions', { id: 'permission', runId: run.id, sessionId: run.sessionId, toolCallId: 'tool', kind: 'write', path: 'note.txt', command: null, before: null, after: 'test', diff: 'test', baseFingerprint: null, version: randomUUID(), status: 'pending', createdAt: now(), expiresAt: now(), reason: 'test' });
  store.event(run.id, run.sessionId, 'run.created', {}); const cursor = store.cursor(); store.close(); store = new Store(directory); store.recover();
  try { assert.equal(store.get('runs', run.id).status, 'interrupted'); assert.equal(store.get('permissions', 'permission').status, 'canceled'); assert.equal(store.get('messages', 'message').text, 'preserved'); assert.ok(store.cursor() > cursor); }
  finally { store.close(); }
}));

test('project file access rejects traversal, symlinks and private files; create/delete stay inside project', async () => fixture(async (base, project) => {
  const outside = join(base, 'outside.txt'); await writeFile(outside, 'outside'); await symlink(outside, join(project, 'escape.txt')); await writeFile(join(project, '.env'), 'SECRET');
  for (const value of ['../outside.txt', outside, 'escape.txt', '.env']) await assert.rejects(readProjectText(project, value));
  const signal = new AbortController().signal;
  await applyText(project, 'docs/new.md', null, 'document', signal); assert.equal(await readFile(join(project, 'docs/new.md'), 'utf8'), 'document');
  await applyText(project, 'docs/new.md', 'document', null, signal); await assert.rejects(readFile(join(project, 'docs/new.md')));
  assert.equal(await readFile(outside, 'utf8'), 'outside');
}));

test('isolated commands execute and abort without writing a late side-effect', async t => fixture(async (_base, project) => {
  if (!commandsAvailable()) { t.skip('bubblewrap is unavailable on this machine'); return; }
  const result = await runCommand(project, 'node -e "process.stdout.write(process.cwd())"', new AbortController().signal);
  assert.equal(result.code, 0); assert.equal(result.output, '/workspace');
  const controller = new AbortController();
  const work = runCommand(project, 'printf started > heartbeat.txt; sleep 20; printf late > after.txt', controller.signal);
  const rejected = assert.rejects(work, /停止/);
  const until = Date.now() + 3000;
  while (Date.now() < until) { try { if (await readFile(join(project, 'heartbeat.txt'), 'utf8') === 'started') break; } catch {} await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(await readFile(join(project, 'heartbeat.txt'), 'utf8'), 'started'); controller.abort(); await rejected;
  await assert.rejects(readFile(join(project, 'after.txt')));
}));
