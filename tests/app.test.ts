import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { AgentRunner } from '../server/agent.js';
import { readRunUsage } from '../server/usage.js';
import { FileRecords } from '../server/artifacts.js';
import { emptyDraft } from '../shared/types.js';
import { PermissionService } from '../server/permissions.js';
import { applyText, readProjectText, textDiff } from '../server/files.js';
import { applyPatch } from 'diff';
import { commandsAvailable, runCommand } from '../server/commands.js';
import { now, type Run } from '../shared/types.js';

const source = fileURLToPath(new URL('../', import.meta.url));
async function fixture(work: (base: string, project: string) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-app-test-'));
  const project = join(base, 'project');
  await mkdir(project);
  await writeFile(join(project, 'note.txt'), 'ORIGINAL\n');
  try {
    await work(base, project);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
function runData(sessionId = 'session', projectId = 'project'): Run {
  return {
    id: randomUUID(),
    sessionId,
    projectId,
    prompt: 'test',
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
    config: { gateway: 'http://127.0.0.1:3001', model: 'test-only', maxTurns: 4, timeoutMs: 10000 },
  };
}

test('real HTTP and SQLite: projects, isolated drafts, idempotent runs, uploads, immutable artifacts and history', async () =>
  fixture(async (base, project) => {
    let starts = 0;
    let pickedDirectory: string | null = null;
    const app = await createApp({
      root: source,
      data: join(base, 'data'),
      pickDirectory: async () => pickedDirectory,
      runnerFactory: (store) => ({
        start(run) {
          starts++;
          store.update('runs', run.id, { status: 'running' });
        },
        stop(id) {
          store.update('runs', id, { status: 'stopped', endedAt: now() });
        },
        async shutdown() {},
      }),
    });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    let token = '';
    const request = async (route: string, method = 'GET', body?: unknown, expected = 200) => {
      const response = await fetch(url + route, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    try {
      token = (await request('/api/bootstrap')).csrfToken;
      const denied = await fetch(url + '/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: project }),
      });
      assert.equal(denied.status, 403);
      const origin = await fetch(url + '/api/bootstrap', {
        headers: { Origin: 'https://example.com' },
      });
      assert.equal(origin.status, 403);
      const pickerRoute = '/api/projects/pick-directory';
      assert.equal((await fetch(url + pickerRoute, { method: 'POST' })).status, 403);
      assert.deepEqual(await request(pickerRoute, 'POST', {}), { path: null });
      pickedDirectory = project;
      const selection = await request(pickerRoute, 'POST', {});
      assert.deepEqual(selection, { path: project });
      assert.equal((await request('/api/projects')).total, 0);
      execFileSync(
        'git',
        [
          'init',
          '--initial-branch=fixture',
          '--separate-git-dir',
          join(base, 'git-metadata'),
          project,
        ],
        { stdio: 'ignore' },
      );
      const p = (await request('/api/projects', 'POST', selection, 201)).project;
      assert.equal(p.branch, 'fixture');
      const s1 = (await request('/api/sessions', 'POST', { projectId: p.id }, 201)).session;
      const s2 = (await request('/api/sessions', 'POST', { projectId: p.id }, 201)).session;
      await request(`/api/sessions/${s2.id}`, 'PATCH', { title: 'Planning archive' });
      assert.equal((await request('/api/sessions?query=ARCHIVE&limit=1')).items[0].id, s2.id);
      const sessionsPage = await request('/api/sessions?limit=1');
      assert.equal(sessionsPage.nextOffset, 1);
      assert.notEqual(
        (await request('/api/sessions?limit=1&offset=1')).items[0].id,
        sessionsPage.items[0].id,
      );
      await request(`/api/sessions/${s1.id}`, 'PATCH', {
        draft: {
          text: 'draft one',
          contextPaths: ['note.txt'],
          attachmentIds: [],
          mode: 'readonly',
        },
      });
      assert.equal((await request(`/api/sessions/${s2.id}`)).session.draft.text, '');
      const upload = app.files.upload.bind(app.files);
      let markEntered!: () => void;
      let releaseUpload!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      app.files.upload = async (...args) => {
        markEntered();
        await release;
        return upload(...args);
      };
      const uploading = request(
        `/api/sessions/${s1.id}/attachments`,
        'POST',
        { name: 'notes.md', contentBase64: Buffer.from('attached content').toString('base64') },
        201,
      );
      try {
        await entered;
        const blocked = await request(`/api/sessions/${s1.id}`, 'DELETE', {}, 409);
        assert.equal(blocked.error.code, 'ATTACHMENT_UPLOAD_ACTIVE');
      } finally {
        releaseUpload();
      }
      const attachment = (await uploading).attachment;
      app.files.upload = upload;
      const attachmentContent = `/api/sessions/${s1.id}/attachments/${attachment.id}/content`;
      assert.equal((await request(attachmentContent)).text, 'attached content');
      await request(
        `/api/sessions/${s2.id}/attachments/${attachment.id}/content`,
        'GET',
        undefined,
        403,
      );
      await request(
        `/api/sessions/${s2.id}`,
        'PATCH',
        { draft: { text: '', contextPaths: [], attachmentIds: [attachment.id], mode: 'readonly' } },
        403,
      );
      const message = {
        text: 'Read note',
        mode: 'readonly',
        attachmentIds: [attachment.id],
        contextPaths: ['note.txt'],
        idempotencyKey: randomUUID(),
      };
      const run = (await request(`/api/sessions/${s1.id}/messages`, 'POST', message, 202)).run;
      assert.equal(
        (await request(`/api/sessions/${s1.id}/messages`, 'POST', message, 202)).run.id,
        run.id,
      );
      assert.equal(starts, 1);
      await request(
        `/api/sessions/${s1.id}/messages`,
        'POST',
        { ...message, text: 'different' },
        409,
      );
      await request(
        `/api/sessions/${s2.id}/messages`,
        'POST',
        { text: 'conflicting run', idempotencyKey: randomUUID() },
        409,
      );
      await mkdir(join(project, 'nested'));
      const nestedProject = (
        await request('/api/projects', 'POST', { path: join(project, 'nested') }, 201)
      ).project;
      const nestedSession = (
        await request('/api/sessions', 'POST', { projectId: nestedProject.id }, 201)
      ).session;
      await request(
        `/api/sessions/${nestedSession.id}/messages`,
        'POST',
        { text: 'overlapping project run', idempotencyKey: randomUUID() },
        409,
      );
      await request(`/api/sessions/${s1.id}`, 'DELETE', {}, 409);
      const longOutput = 'long-output '.repeat(3000) + 'END';
      const toolId = run.id + ':large-output';
      app.store.put('tools', {
        id: toolId,
        runId: run.id,
        sessionId: s1.id,
        name: 'test-output',
        inputSummary: '',
        status: 'succeeded',
        output: longOutput.slice(0, 32000),
        outputLength: longOutput.length,
        outputTruncated: true,
        startedAt: now(),
        endedAt: now(),
      });
      app.files.saveOutput(toolId, longOutput);
      const firstPage = await request(`/api/tools/${encodeURIComponent(toolId)}/output`);
      assert.equal(firstPage.text, longOutput.slice(0, 16000));
      assert.equal(firstPage.nextOffset, 16000);
      const rest = await request(
        `/api/tools/${encodeURIComponent(toolId)}/output?offset=16000&limit=32000`,
      );
      assert.equal(firstPage.text + rest.text, longOutput);
      assert.equal(
        await (
          await fetch(url + `/api/tools/${encodeURIComponent(toolId)}/output?download=1`)
        ).text(),
        longOutput,
      );
      const artifact = await app.files.publish(
        app.store.get('runs', run.id),
        'report.md',
        'version one',
      );
      await writeFile(join(project, 'report.md'), 'unrelated version');
      assert.equal((await request(`/api/artifacts/${artifact.id}/content`)).text, 'version one');
      const prototype = await app.files.publish(
        app.store.get('runs', run.id),
        'prototype.html',
        '<h1>Example</h1>',
      );
      const preview = await fetch(url + `/api/artifacts/${prototype.id}/preview`);
      assert.equal(preview.status, 200);
      assert.match(preview.headers.get('content-type') ?? '', /^text\/html/);
      assert.match(preview.headers.get('content-security-policy') ?? '', /^sandbox allow-scripts;/);
      assert.equal(preview.headers.get('x-frame-options'), null);
      assert.equal(await preview.text(), '<h1>Example</h1>');
      assert.equal((await request(`/api/artifacts/${prototype.id}/content`)).previewKind, 'html');
      const nonHtmlPreview = await fetch(url + `/api/artifacts/${artifact.id}/preview`);
      assert.equal(nonHtmlPreview.status, 404);
      await nonHtmlPreview.body?.cancel();
      await request(`/api/runs/${run.id}/stop`, 'POST', {});
      const retry = (
        await request(`/api/runs/${run.id}/retry`, 'POST', { idempotencyKey: randomUUID() }, 202)
      ).run;
      assert.notEqual(retry.id, run.id);
      assert.equal(retry.mode, 'readonly');
      assert.equal(retry.retryOf, run.id);
      await request(`/api/runs/${retry.id}/stop`, 'POST', {});
      const runPage = await request(`/api/runs?sessionId=${s1.id}&status=stopped&limit=1`);
      assert.equal(runPage.total, 2);
      assert.equal(runPage.nextOffset, 1);
      assert.equal(runPage.items[0].id, retry.id);
      assert.equal(
        (await request(`/api/runs?sessionId=${s1.id}&status=stopped&limit=1&offset=1`)).items[0].id,
        run.id,
      );
      assert.equal((await request(attachmentContent)).text, 'attached content');
      await request(`/api/sessions/${s1.id}/attachments/${attachment.id}`, 'DELETE', {});
      await request(attachmentContent, 'GET', undefined, 403);
      const snapshot = await request(`/api/sessions/${s1.id}`);
      assert.equal(snapshot.runs.length, 2);
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.artifacts.length, 2);
      assert.equal(
        snapshot.attachments.find((item: { id: string }) => item.id === attachment.id)?.name,
        'notes.md',
      );
      assert.equal(
        snapshot.attachments.find((item: { id: string }) => item.id === attachment.id)?.removed,
        true,
      );
      assert.deepEqual(snapshot.session.draft.attachmentIds, []);
      assert.deepEqual(
        snapshot.runs.find((item: { id: string }) => item.id === run.id)?.attachmentIds,
        [attachment.id],
      );
      await request(
        `/api/sessions/${s1.id}/messages`,
        'POST',
        { ...message, idempotencyKey: randomUUID() },
        403,
      );
      const cursor = app.store.cursor();
      const event = app.store.event(run.id, s1.id, 'test.changed', {});
      assert.equal(app.store.since(cursor)[0]?.id, event.id);
      for (let index = 0; index < 501; index++) app.store.event(retry.id, s1.id, 'message.delta');
      const diagnostic = await request(`/api/runs/${run.id}/trace`);
      assert.ok(diagnostic.events.some((item: { id: number }) => item.id === event.id));
      assert.ok(diagnostic.events.every((item: { runId: string }) => item.runId === run.id));
      app.store.event(run.id, s1.id, 'sdk.api_retry', {
        attempt: 1,
        httpStatus: 429,
        retryDelayMs: 1000,
        headers: { authorization: 'fixture-secret-header' },
      });
      app.store.event(run.id, s1.id, 'sdk.error', {
        code: 'sk-fixture-secret-code',
        reason: 'fixture-private-error',
      });
      const download = await fetch(`${url}/api/runs/${run.id}/diagnostics.json`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-disposition') ?? '', /^attachment;.*\.json/);
      const exported = await download.text();
      const report = JSON.parse(exported);
      assert.equal(report.run.id, run.id);
      assert.equal(
        report.events.find((item: { type: string }) => item.type === 'sdk.api_retry').details
          .httpStatus,
        429,
      );
      assert.equal(report.tools[0].id, toolId);
      assert.doesNotMatch(exported, /fixture-secret|fixture-private|long-output |Read note/);
      assert.ok(!exported.includes(project));
      const streamingTrace = await request(`/api/runs/${retry.id}/trace`);
      assert.equal(streamingTrace.eventCount - streamingTrace.events.length, 501);
      assert.ok(
        streamingTrace.events.every((item: { type: string }) => item.type !== 'message.delta'),
      );
      const controller = new AbortController();
      const stream = await fetch(url + `/api/events?after=${cursor}`, {
        signal: controller.signal,
      });
      const reader = stream.body!.getReader();
      let received = '';
      while (!received.includes('test.changed'))
        received += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      const resetController = new AbortController();
      try {
        const cursorBeforeReset = app.store.cursor();
        const resetStream = await fetch(`${url}/api/events?after=0`, {
          headers: { 'Last-Event-ID': String(cursorBeforeReset + 1000) },
          signal: resetController.signal,
        });
        const resetReader = resetStream.body!.getReader();
        const next = app.store.event(run.id, s1.id, 'test.resumed', {});
        let frames = '';
        while (!frames.includes('test.resumed')) {
          const frame = await resetReader.read();
          assert.equal(frame.done, false);
          frames += new TextDecoder().decode(frame.value);
        }
        assert.ok(frames.includes(`id: ${cursorBeforeReset}\nevent: cursor-reset`));
        assert.ok(frames.includes(`id: ${next.id}\ndata:`));
      } finally {
        resetController.abort();
      }
      await request(`/api/sessions/${s1.id}`, 'PATCH', { title: 'Renamed', status: 'archived' });
      assert.equal(
        (await request('/api/sessions?includeArchived=true')).items.find(
          (s: { id: string }) => s.id === s1.id,
        ).title,
        'Renamed',
      );
      await request(`/api/sessions/${s1.id}`, 'PATCH', { status: 'active' });
      await request(`/api/sessions/${s1.id}`, 'DELETE', {});
      assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'ORIGINAL\n');
      await request(`/api/artifacts/${artifact.id}/content`, 'GET', undefined, 404);
    } finally {
      await app.close();
    }
  }));

test('usage distinguishes failed placeholder counters and isolates per-run SDK estimates', () => {
  const placeholder = readRunUsage(
    { is_error: true, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } },
    'fixture',
    0.15,
  );
  assert.equal(placeholder.usage.inputTokens, null);
  assert.equal(placeholder.cumulativeCost, null);
  assert.equal(placeholder.usage.complete, false);
  const measured = {
    is_error: false,
    total_cost_usd: 0.25,
    usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 0 },
  };
  assert.equal(readRunUsage(measured, 'fixture', 0.15).usage.sdkEstimateUsd, 0.1);
  assert.equal(readRunUsage(measured, 'fixture', null).usage.sdkEstimateUsd, null);
  assert.equal(readRunUsage(measured, 'fixture', 0.5).usage.sdkEstimateUsd, null);
  assert.equal(readRunUsage(measured, 'fixture', 0).usage.cacheReadTokens, 0);
});

test('repeated stop and shutdown preserve the first cancellation and finalize once', async () =>
  fixture(async (base, project) => {
    const store = new Store(join(base, 'data'));
    const runner = new AgentRunner(store, new PermissionService(store), new FileRecords(store));
    const run = runData();
    const at = now();
    store.put('projects', {
      id: run.projectId,
      name: 'fixture',
      path: project,
      branch: '',
      available: true,
      createdAt: at,
    });
    store.put('sessions', {
      id: run.sessionId,
      projectId: run.projectId,
      title: 'fixture',
      status: 'active',
      sdkSessionId: null,
      createdAt: at,
      updatedAt: at,
      draft: emptyDraft(),
    });
    store.put('runs', { ...run, status: 'queued', startedAt: null });
    try {
      runner.start(run, 'stop during startup');
      runner.stop(run.id);
      runner.stop(run.id);
      assert.equal(store.get('runs', run.id).status, 'stopping');
      await runner.shutdown();
      assert.equal(store.get('runs', run.id).status, 'stopped');
      const { events } = store.runHistory(run.id);
      assert.deepEqual(
        events.filter((e) => e.payload.status === 'stopping').map((e) => e.payload.reason),
        ['user'],
      );
      assert.equal(events.filter((e) => e.type === 'run.finished').length, 1);
      assert.ok(events.every((e) => e.type !== 'process.spawned'));
    } finally {
      await runner.shutdown();
      store.close();
    }
  }));

test('permission expiry during the file baseline check prevents approval', async () =>
  fixture(async (base, project) => {
    const store = new Store(join(base, 'data'));
    const service = new PermissionService(store);
    const run = runData();
    store.put('runs', run);
    store.put('tools', {
      id: run.id,
      runId: run.id,
      sessionId: run.sessionId,
      name: 'edit_file',
      inputSummary: '',
      status: 'running',
      output: '',
      startedAt: now(),
      endedAt: null,
    });
    try {
      const request = service.request(
        run,
        project,
        {
          toolCallId: run.id,
          kind: 'edit',
          path: 'note.txt',
          before: 'ORIGINAL\n',
          after: 'APPROVED\n',
          reason: 'fixture',
        },
        new AbortController().signal,
      );
      const rejected = assert.rejects(request, { code: 'PERMISSION_DENIED' });
      const permission = store.list('permissions')[0]!;
      const decision = service.decide(permission.id, 'allow', permission.version);
      store.update('permissions', permission.id, { expiresAt: new Date(0).toISOString() });
      await assert.rejects(decision, { code: 'PERMISSION_EXPIRED' });
      await rejected;
      const expired = store.get('permissions', permission.id);
      assert.equal(expired.status, 'expired');
      assert.equal(expired.reason, 'fixture');
      assert.match(expired.resolutionReason ?? '', /超时/);
      assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'ORIGINAL\n');
    } finally {
      service.cancelRun(run.id);
      store.close();
    }
  }));

test('approval baseline change, duplicate decisions and cancel race cannot apply stale writes', async () =>
  fixture(async (base, project) => {
    const store = new Store(join(base, 'data'));
    const service = new PermissionService(store, 1000);
    const prepare = () => {
      const run = runData();
      store.put('runs', run);
      store.put('tools', {
        id: run.id,
        runId: run.id,
        sessionId: run.sessionId,
        name: 'edit_file',
        inputSummary: '',
        status: 'running',
        output: '',
        startedAt: now(),
        endedAt: null,
      });
      return run;
    };
    try {
      let run = prepare();
      let controller = new AbortController();
      let pending = service.request(
        run,
        project,
        {
          toolCallId: run.id,
          kind: 'edit',
          path: 'note.txt',
          before: 'ORIGINAL\n',
          after: 'APPROVED\n',
          reason: 'test',
        },
        controller.signal,
      );
      const rejected = assert.rejects(pending, /拒绝/);
      const permission = store.list('permissions').find((p) => p.runId === run.id)!;
      await writeFile(join(project, 'note.txt'), 'EXTERNAL CHANGE\n');
      await assert.rejects(
        service.decide(permission.id, 'allow', permission.version),
        /文件内容已变化/,
      );
      await rejected;
      assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'EXTERNAL CHANGE\n');
      await writeFile(join(project, 'note.txt'), 'ORIGINAL\n');
      run = prepare();
      controller = new AbortController();
      pending = service.request(
        run,
        project,
        {
          toolCallId: run.id,
          kind: 'edit',
          path: 'note.txt',
          before: 'ORIGINAL\n',
          after: 'APPROVED\n',
          reason: 'test',
        },
        controller.signal,
      );
      const p2 = store.list('permissions').find((p) => p.runId === run.id)!;
      const results = await Promise.all([
        service.decide(p2.id, 'allow', p2.version),
        service.decide(p2.id, 'allow', p2.version),
      ]);
      assert.ok(results.every((p) => p.status === 'allowed'));
      await pending;
      await applyText(project, 'note.txt', 'ORIGINAL\n', 'APPROVED\n', controller.signal);
      await assert.rejects(
        applyText(project, 'note.txt', 'ORIGINAL\n', 'APPROVED\n', controller.signal),
        /变化/,
      );
      run = prepare();
      controller = new AbortController();
      pending = service.request(
        run,
        project,
        {
          toolCallId: run.id,
          kind: 'delete',
          path: 'note.txt',
          before: 'APPROVED\n',
          after: null,
          reason: 'test',
        },
        controller.signal,
      );
      const canceled = assert.rejects(pending);
      const p3 = store.list('permissions').find((p) => p.runId === run.id)!;
      store.update('runs', run.id, { status: 'stopping' });
      controller.abort();
      await canceled;
      await assert.rejects(service.decide(p3.id, 'allow', p3.version), /取消|过期/);
      assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'APPROVED\n');
    } finally {
      store.close();
    }
  }));

test('restart persists distinct runs and invalidates ordinary pending approvals', async () =>
  fixture(async (base) => {
    const directory = join(base, 'data');
    let store = new Store(directory);
    const run = runData();
    store.put('runs', run);
    store.put('messages', {
      id: 'message',
      sessionId: run.sessionId,
      runId: run.id,
      role: 'user',
      text: 'preserved',
      createdAt: now(),
    });
    store.put('permissions', {
      id: 'permission',
      runId: run.id,
      sessionId: run.sessionId,
      toolCallId: 'tool',
      kind: 'write',
      path: 'note.txt',
      command: null,
      before: null,
      after: 'test',
      diff: 'test',
      baseFingerprint: null,
      version: randomUUID(),
      status: 'pending',
      createdAt: now(),
      expiresAt: now(),
      reason: 'test',
    });
    store.event(run.id, run.sessionId, 'run.created', {});
    const cursor = store.cursor();
    store.close();
    store = new Store(directory);
    store.recover();
    try {
      assert.equal(store.get('runs', run.id).status, 'interrupted');
      assert.equal(store.get('permissions', 'permission').status, 'canceled');
      assert.equal(store.get('messages', 'message').text, 'preserved');
      assert.ok(store.cursor() > cursor);
    } finally {
      store.close();
    }
  }));

test('approval preview describes exactly the bytes applied, including BOM and final newline', async () =>
  fixture(async (_base, project) => {
    const before = '﻿first\r\nline\r\nlast\r\n';
    const after = '﻿first\r\nchanged\r\nlast';
    const file = join(project, 'note.txt');
    await writeFile(file, before);
    assert.equal(await readProjectText(project, 'note.txt'), before);
    const patch = textDiff('note.txt', before, after);
    assert.match(patch, /@@/);
    assert.equal(applyPatch(before, patch), after);
    assert.equal(applyPatch('', textDiff('new.md', null, 'new')), 'new');
    assert.equal(applyPatch('old\n', textDiff('old.md', 'old\n', null)), '');
    const signal = new AbortController().signal;
    await applyText(project, 'note.txt', before, after, signal);
    assert.deepEqual(await readFile(file), Buffer.from(after));
    const results = await Promise.allSettled(
      ['alpha', 'beta'].map((text) => applyText(project, 'shared.txt', null, text, signal)),
    );
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal(
      await readFile(join(project, 'shared.txt'), 'utf8'),
      results[0]?.status === 'fulfilled' ? 'alpha' : 'beta',
    );
  }));

test('project file access rejects traversal, symlinks and private files; create/delete stay inside project', async () =>
  fixture(async (base, project) => {
    const outside = join(base, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(project, 'escape.txt'));
    await writeFile(join(project, '.env'), 'SECRET');
    for (const value of ['../outside.txt', outside, 'escape.txt', '.env'])
      await assert.rejects(readProjectText(project, value));
    const signal = new AbortController().signal;
    await applyText(project, 'docs/new.md', null, 'document', signal);
    assert.equal(await readFile(join(project, 'docs/new.md'), 'utf8'), 'document');
    await applyText(project, 'docs/new.md', 'document', null, signal);
    await assert.rejects(readFile(join(project, 'docs/new.md')));
    assert.equal(await readFile(outside, 'utf8'), 'outside');
  }));

test('isolated commands execute and abort without writing a late side-effect', async (t) =>
  fixture(async (_base, project) => {
    if (!commandsAvailable()) {
      t.skip('bubblewrap is unavailable on this machine');
      return;
    }
    const result = await runCommand(
      project,
      'node -e "process.stdout.write(process.cwd())"',
      new AbortController().signal,
    );
    assert.equal(result.code, 0);
    assert.equal(result.output, '/workspace');
    const oldSecret = process.env.ATELIER_TEST_SECRET;
    process.env.ATELIER_TEST_SECRET = 'synthetic-command-boundary-marker';
    try {
      const environment = await runCommand(
        project,
        `node -e 'let inherited = !!process.env.ATELIER_TEST_SECRET; try { inherited ||= require("node:fs").readFileSync("/proc/1/environ", "utf8").includes("ATELIER_TEST_SECRET="); } catch {} process.stdout.write(inherited ? "leaked" : "clean")'`,
        new AbortController().signal,
      );
      assert.equal(environment.code, 0);
      assert.equal(environment.output, 'clean');
    } finally {
      if (oldSecret === undefined) delete process.env.ATELIER_TEST_SECRET;
      else process.env.ATELIER_TEST_SECRET = oldSecret;
    }
    const controller = new AbortController();
    const work = runCommand(
      project,
      'printf started > heartbeat.txt; sleep 20; printf late > after.txt',
      controller.signal,
    );
    const rejected = assert.rejects(work, /停止/);
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      try {
        if ((await readFile(join(project, 'heartbeat.txt'), 'utf8')) === 'started') break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await readFile(join(project, 'heartbeat.txt'), 'utf8'), 'started');
    controller.abort();
    await rejected;
    await assert.rejects(readFile(join(project, 'after.txt')));
  }));
