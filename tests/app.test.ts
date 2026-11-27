/**
 * @file 验证工作台服务、持久化与权限行为。
 * @implementation 利用隔离临时目录、HTTP、SQLite 和运行器替身验证会话、运行、文件、审批和恢复。
 * @updated 2026-11-20T02:00+08:00
 */
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
import {
  now,
  type Run,
  type Session,
  type SendSessionMessageResult,
  type SessionMessageQueue,
} from '../shared/types.js';
import type { LiveInput } from '../server/agent.js';
import { MessageQueue } from '../server/message-queue.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import { setTimeout as delay } from 'node:timers/promises';

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

async function appClient(app: Awaited<ReturnType<typeof createApp>>, pairing?: string) {
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (pairing) headers[desktopPairingHeader] = pairing;
  const boot = (await fetch(url + '/api/bootstrap', { headers }).then((res) => res.json())) as {
    csrfToken: string;
    capabilities: { nativeExecution: boolean };
  };
  headers['x-atelier-token'] = boot.csrfToken;
  async function request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    expected = 200,
  ): Promise<T> {
    const res = await fetch(url + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await res.json();
    assert.equal(res.status, expected, JSON.stringify(value));
    return value as T;
  }
  return { request, boot, url, headers };
}

test(
  'project directory Skills are shared by automatic approval and native trust, not ordinary edit',
  { skip: process.platform !== 'linux' },
  async () =>
    fixture(async (base, project) => {
      const directory = join(project, '.claude', 'skills', 'fixture-notes');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'SKILL.md'),
        '---\ndescription: Scope fixture\n---\nPROJECT_FIXTURE_INSTRUCTIONS',
      );
      const pairing = 'paired-project-skill-fixture';
      const captured: { executor: Run['executor']; input: string; skillIds: string[] }[] = [];
      const app = await createApp({
        root: source,
        data: join(base, 'data'),
        nativeExecution: true,
        desktopPairing: pairing,
        runnerFactory: (store) => ({
          start(run, input, _mcp, skills) {
            captured.push({
              executor: run.executor,
              input,
              skillIds: skills?.map(({ id }) => id) ?? [],
            });
            store.update('runs', run.id, { status: 'completed', endedAt: now() });
          },
          stop() {},
          async shutdown() {},
        }),
      });
      try {
        const { request } = await appClient(app, pairing);
        const { project: bound } = await request<{ project: { id: string } }>(
          '/api/projects',
          'POST',
          { path: project },
          201,
        );
        const { session } = await request<{ session: Session }>(
          '/api/sessions',
          'POST',
          { projectId: bound.id },
          201,
        );
        const scope = `/api/skill-inheritance?sessionId=${session.id}`;
        const read = async (suffix: string) =>
          (
            await request<{
              items: import('../shared/skill-inheritance.js').SkillInheritanceItem[];
            }>(scope + suffix)
          ).items.find(({ source }) => source === 'workspace');
        assert.equal((await read(''))?.effective, 'off');
        const automatic = await read('&automatic=1');
        const native = await read('&native=1');
        assert.ok(automatic?.manual);
        assert.equal(automatic.effective, 'auto');
        assert.equal(native?.id, automatic.id);
        assert.equal(native?.effective, 'auto');
        await request(scope + '&automatic=1&native=1', 'GET', undefined, 400);
        const requestMessage = (policy: object, status = 202) =>
          request(
            `/api/sessions/${session.id}/messages`,
            'POST',
            {
              text: 'Use this Skill',
              mode: 'edit',
              idempotencyKey: randomUUID(),
              extensionSelections: [{ id: automatic.id, version: automatic.version }],
              ...policy,
            },
            status,
          );
        await requestMessage({}, 409);
        await requestMessage({ approvalMode: 'automatic' });
        await requestMessage({ executionPreference: 'native-v1' });
        assert.deepEqual(
          captured.map(({ executor }) => executor),
          ['project-v1', 'native-v1'],
        );
        assert.ok(captured.every(({ input }) => input.includes('PROJECT_FIXTURE_INSTRUCTIONS')));
        assert.deepEqual(
          captured[0]?.skillIds,
          [],
          'Do not mount the already selected text a second time',
        );
        await request(
          `/api/sessions/${session.id}/messages`,
          'POST',
          {
            text: 'Use available Skills if needed',
            mode: 'edit',
            approvalMode: 'automatic',
            idempotencyKey: randomUUID(),
          },
          202,
        );
        assert.deepEqual(captured[2]?.skillIds, [automatic.id]);
        await request(scope + '&automatic=1', 'PATCH', {
          type: 'session',
          id: automatic.id,
          mode: 'off',
        });
        await requestMessage({ approvalMode: 'automatic' }, 409);
      } finally {
        await app.close();
      }
    }),
);

for (const settings of [
  {
    nativeExecution: true,
    desktopPairing: 'paired-fixture',
    enabled: process.platform === 'linux',
  },
  { nativeExecution: true, desktopPairing: undefined, enabled: false },
  { nativeExecution: false, desktopPairing: 'paired-fixture', enabled: false },
]) {
  test(`native execution is authoritative with enabled=${settings.nativeExecution} paired=${Boolean(settings.desktopPairing)}`, async () =>
    fixture(async (base, project) => {
      const app = await createApp({
        root: source,
        data: join(base, 'data'),
        ...settings,
        runnerFactory: (store) => ({
          start(run) {
            store.update('runs', run.id, { status: 'stopped', endedAt: now() });
          },
          stop() {},
          async shutdown() {},
        }),
      });
      try {
        const { request, boot, url, headers } = await appClient(app, settings.desktopPairing);
        assert.equal(boot.capabilities.nativeExecution, settings.enabled);
        if (settings.desktopPairing) {
          const unpaired = await fetch(url + '/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-atelier-token': boot.csrfToken },
            body: JSON.stringify({ nativeExecution: true }),
          });
          assert.equal(unpaired.status, 403);
          assert.equal(
            ((await unpaired.json()) as { error: { code: string } }).error.code,
            'DESKTOP_PAIRING_REQUIRED',
          );
          assert.equal(headers[desktopPairingHeader], settings.desktopPairing);
        }
        const { project: bound } = await request<{ project: { id: string } }>(
          '/api/projects',
          'POST',
          { path: project },
          201,
        );
        const { session } = await request<{ session: Session }>(
          '/api/sessions',
          'POST',
          { projectId: bound.id },
          201,
        );
        assert.equal(session.draft.mode, settings.enabled ? 'edit' : 'readonly');
        assert.equal(session.draft.executionPreference, settings.enabled ? 'native-v1' : undefined);
        const route = `/api/sessions/${session.id}/messages`;
        const native = {
          text: 'local task',
          mode: 'edit',
          executionPreference: 'native-v1',
          idempotencyKey: randomUUID(),
        };
        if (!settings.enabled) {
          await request(route, 'POST', native, 403);
          await request(
            `/api/sessions/${session.id}`,
            'PATCH',
            { draft: { ...session.draft, mode: 'edit', executionPreference: 'native-v1' } },
            403,
          );
        } else {
          const first = await request<{ run: Run }>(route, 'POST', native, 202);
          assert.equal(first.run.executor, 'native-v1');
          assert.equal(
            (await request<{ run: Run }>(route, 'POST', native, 202)).run.id,
            first.run.id,
          );
          await request(route, 'POST', { ...native, executionPreference: 'project-v1' }, 409);
          for (const invalid of [{ mode: 'readonly' }, { approvalMode: 'automatic' }])
            await request(
              route,
              'POST',
              { ...native, ...invalid, idempotencyKey: randomUUID() },
              400,
            );
          const retried = await request<{ run: Run }>(
            `/api/runs/${first.run.id}/retry`,
            'POST',
            { idempotencyKey: randomUUID() },
            202,
          );
          assert.equal(retried.run.mode, 'readonly');
          assert.equal(retried.run.executor, 'project-v1');
          assert.equal(
            app.store.get('sessions', session.id).draft.executionPreference,
            'native-v1',
          );
        }
        for (const explicit of [
          { mode: 'readonly' },
          { mode: 'edit' },
          { mode: 'edit', approvalMode: 'automatic' },
          {
            mode: 'edit',
            executionPreference: 'project-v1',
            executor: 'native-v1',
            nativeExecution: true,
          },
        ]) {
          const { run } = await request<{ run: Run }>(
            route,
            'POST',
            { text: 'explicit policy', ...explicit, idempotencyKey: randomUUID() },
            202,
          );
          assert.equal(run.executor, 'project-v1');
          assert.equal(run.mode, explicit.mode);
        }
        if (settings.enabled) {
          // A lost draft PATCH must not preserve a previous automatic choice after an explicit send.
          for (const preference of ['native-v1', 'project-v1'] as const) {
            app.store.update('sessions', session.id, {
              draft: { ...emptyDraft(), mode: 'edit', approvalMode: 'automatic' },
            });
            await request(
              route,
              'POST',
              { ...native, executionPreference: preference, idempotencyKey: randomUUID() },
              202,
            );
            const saved = app.store.get('sessions', session.id).draft;
            assert.equal(saved.mode, 'edit');
            assert.equal(saved.approvalMode, undefined);
            assert.equal(saved.executionPreference, preference);
          }
          const { agent } = await request<{ agent: { revisionId: string } }>(
            `/api/projects/${bound.id}/agents`,
            'POST',
            {
              name: 'Restricted fixture',
              description: 'fixture',
              instructions: 'Only read the project.',
              starters: [],
              mode: 'readonly',
              capabilities: ['read'],
              skills: [],
              mcp: [],
            },
            201,
          );
          const boundSession = await request<{ session: Session }>(
            '/api/sessions',
            'POST',
            {
              projectId: bound.id,
              agentRevisionId: agent.revisionId,
            },
            201,
          );
          assert.equal(boundSession.session.draft.executionPreference, undefined);
          assert.equal(boundSession.session.draft.mode, 'readonly');
          await request(
            `/api/sessions/${boundSession.session.id}/messages`,
            'POST',
            { ...native, idempotencyKey: randomUUID() },
            403,
          );
          // An old or forked session can opt in only through an explicit saved choice.
          app.store.update('sessions', session.id, {
            draft: emptyDraft(),
            fork: {
              sourceSessionId: randomUUID(),
              sourceMessageId: randomUUID(),
              sourceTitle: 'fixture origin',
            },
          });
          const nativeDraft = { ...emptyDraft(), mode: 'edit', executionPreference: 'native-v1' };
          await request(`/api/sessions/${session.id}`, 'PATCH', { draft: nativeDraft });
          assert.equal(
            app.store.get('sessions', session.id).draft.executionPreference,
            'native-v1',
          );
          await request(`/api/sessions/${session.id}`, 'PATCH', {
            draft: { ...emptyDraft(), mode: 'edit', executionPreference: 'project-v1' },
          });
          assert.equal(
            app.store.get('sessions', session.id).draft.executionPreference,
            'project-v1',
          );
          app.store.update('sessions', session.id, { agentRevisionId: randomUUID() });
          await request(route, 'POST', { ...native, idempotencyKey: randomUUID() }, 403);
          await request(`/api/sessions/${session.id}`, 'PATCH', { draft: nativeDraft }, 403);
        }
      } finally {
        await app.close();
      }
    }));
}

test('native executor is pinned across queued turns, live dispatch and reopening; missing intent stays project', async () =>
  fixture(async (base, project) => {
    const starts: Run[] = [];
    let live: LiveInput | undefined;
    let inputSlotReady = false;
    const pairing = 'queue-fixture';
    const launch = async () => {
      const app = await createApp({
        root: source,
        data: join(base, 'data'),
        desktopPairing: pairing,
        nativeExecution: true,
        runnerFactory: (store) => ({
          start(run) {
            starts.push(run);
            store.update('runs', run.id, { status: 'running', startedAt: now() });
          },
          insert(_id, input) {
            live = input;
          },
          hasLiveInputSlot: () => inputSlotReady,
          stop(id) {
            store.update('runs', id, { status: 'stopped', endedAt: now() });
          },
          async shutdown() {},
        }),
      });
      return { app, ...(await appClient(app, pairing)) };
    };
    let running = await launch();
    try {
      const { project: bound } = await running.request<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: project },
        201,
      );
      const { session } = await running.request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: bound.id },
        201,
      );
      const path = `/api/sessions/${session.id}`;
      const send = (text: string, executor: 'native-v1' | 'project-v1') => ({
        text,
        mode: 'edit',
        executionPreference: executor,
        idempotencyKey: randomUUID(),
      });
      const firstBody = send('native first', 'native-v1');
      const first = await running.request<{ run: Run }>(path + '/messages', 'POST', firstBody, 202);
      assert.equal(first.run.executor, 'native-v1');
      const controlled = await running.request<SendSessionMessageResult>(
        path + '/messages',
        'POST',
        send('controlled queued', 'project-v1'),
        202,
      );
      const nativeBody = send('native queued', 'native-v1');
      const native = await running.request<SendSessionMessageResult>(
        path + '/messages',
        'POST',
        nativeBody,
        202,
      );
      assert.ok(controlled.queuedMessage && native.queuedMessage);
      assert.equal(native.queuedMessage.insertion, undefined);
      await running.request(
        `${path}/message-queue/${native.queuedMessage.id}/insert`,
        'POST',
        { runId: first.run.id, mode: 'live' },
        409,
      );
      assert.equal(Boolean(live), false);
      inputSlotReady = true;
      const snapshot = await running.request<{ messageQueue: SessionMessageQueue }>(path);
      assert.equal(
        snapshot.messageQueue.items.find((item) => item.id === controlled.queuedMessage.id)
          ?.insertion,
        'priority',
      );
      assert.equal(
        snapshot.messageQueue.items.find((item) => item.id === native.queuedMessage.id)?.insertion,
        'live',
      );
      await running.request(
        `${path}/message-queue/${controlled.queuedMessage.id}/insert`,
        'POST',
        { runId: first.run.id, mode: 'live' },
        409,
      );
      await running.request(`${path}/message-queue/${native.queuedMessage.id}/insert`, 'POST', {
        runId: first.run.id,
        mode: 'live',
      });
      assert.ok(live);
      assert.equal(live.canDispatch?.(), true);
      running.app.store.update('runs', first.run.id, { executor: 'project-v1' });
      assert.equal(live.canDispatch?.(), false);
      running.app.store.update('runs', first.run.id, { executor: 'native-v1' });
      live.released();
      // Build a historical intent using the exact old scope, without either new field.
      const queue = new MessageQueue(running.app.store);
      const pending = queue.pending(session.id, controlled.queuedMessage.id);
      assert.ok(pending);
      const oldIntent = pending.intent as {
        request: Record<string, unknown>;
        scope: string;
        model: string;
      };
      const { executionPreference: _preference, ...oldRequest } = oldIntent.request;
      const legacy = queue.enqueue(
        session.id,
        `${session.id}:${randomUUID()}`,
        'legacy-hash',
        { text: 'legacy queued' },
        {
          request: { ...oldRequest, text: 'legacy queued', idempotencyKey: randomUUID() },
          model: oldIntent.model,
          scope: oldIntent.scope,
        },
      );
      await running.request(path, 'PATCH', {
        draft: { ...session.draft, executionPreference: 'native-v1' },
      });
      await running.app.close();
      running = await launch();
      assert.equal(running.app.store.get('runs', first.run.id).executor, 'native-v1');
      assert.equal(
        running.app.store.get('sessions', session.id).draft.executionPreference,
        'native-v1',
      );
      assert.equal(
        (await running.request<{ run: Run }>(path + '/messages', 'POST', firstBody, 202)).run.id,
        first.run.id,
      );
      const finish = (id: string) => {
        running.app.store.update('runs', id, { status: 'completed', endedAt: now() });
        running.app.store.event(id, session.id, 'run.finished', {});
      };
      await running.request(`${path}/message-queue/resume`, 'POST', {});
      const awaitStarts = async (count: number) => {
        const end = Date.now() + 3000;
        while (starts.length < count) {
          assert.ok(Date.now() < end);
          await delay(10);
        }
      };
      await awaitStarts(2);
      const second = starts[1];
      assert.ok(second);
      assert.equal(second.executor, 'project-v1');
      finish(second.id);
      await awaitStarts(3);
      const third = starts[2];
      assert.ok(third);
      assert.equal(third.executor, 'native-v1');
      finish(third.id);
      await awaitStarts(4);
      const fourth = starts[3];
      assert.ok(fourth);
      assert.equal(fourth.executor, 'project-v1');
      assert.equal(fourth.prompt, legacy.text);
      assert.equal(
        (
          await running.request<SendSessionMessageResult>(
            path + '/messages',
            'POST',
            nativeBody,
            202,
          )
        ).run?.id,
        third.id,
      );
    } finally {
      await running.app.close();
    }
  }));

test('manual subtask stop checks token, pairing and ownership and remains idempotent after completion', async () =>
  fixture(async (base, project) => {
    const stopped: string[] = [];
    const app = await createApp({
      root: source,
      data: join(base, 'data'),
      desktopPairing: 'stop-fixture',
      runnerFactory: (store) => ({
        start(run) {
          store.update('runs', run.id, { status: 'running' });
        },
        stop() {},
        async stopSubagent(runId, id) {
          stopped.push(id);
          store.finishSubagent(id, runId, 'stopped', '用户停止');
        },
        async shutdown() {},
      }),
    });
    try {
      const { request, url, headers } = await appClient(app, 'stop-fixture');
      const { project: bound } = await request<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: project },
        201,
      );
      const { session } = await request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: bound.id },
        201,
      );
      const { run } = await request<{ run: Run }>(
        `/api/sessions/${session.id}/messages`,
        'POST',
        { text: 'task', idempotencyKey: randomUUID() },
        202,
      );
      const child = (id: string, runId = run.id, sessionId = session.id) => ({
        id,
        runId,
        sessionId,
        title: id,
        kind: 'worker' as const,
        status: 'running' as const,
        summary: null,
        startedAt: now(),
        endedAt: null,
      });
      app.store.startSubagent(child('worker'));
      app.store.startSubagent(child('peer'));
      const foreignRun = { ...runData(session.id, bound.id), mode: 'readonly' as const };
      app.store.put('runs', foreignRun);
      app.store.startSubagent(child('foreign', foreignRun.id));
      const route = `/api/runs/${run.id}/subagents/worker/stop`;
      const { 'x-atelier-token': _token, ...missingToken } = headers;
      assert.equal(
        (await fetch(url + route, { method: 'POST', headers: missingToken, body: '{}' })).status,
        403,
      );
      const { [desktopPairingHeader]: _pairing, ...missingPair } = headers;
      assert.equal(
        (await fetch(url + route, { method: 'POST', headers: missingPair, body: '{}' })).status,
        403,
      );
      await request(`/api/runs/${run.id}/subagents/foreign/stop`, 'POST', {}, 404);
      await request(route, 'POST', { runId: foreignRun.id }, 400);
      await request(route, 'POST', {});
      await request(route, 'POST', {});
      assert.deepEqual(stopped, ['worker']);
      const work = app.store.sessionSnapshots.read(session.id).subagents;
      assert.equal(work.find((item) => item.id === 'worker')?.status, 'stopped');
      assert.equal(work.find((item) => item.id === 'peer')?.status, 'running');
      assert.equal(app.store.get('runs', run.id).status, 'running');
      app.store.update('runs', run.id, { status: 'completed' });
      await request(`/api/runs/${run.id}/subagents/peer/stop`, 'POST', {}, 409);
    } finally {
      await app.close();
    }
  }));

test('long tasks are the default and legacy custom limits are preserved', async () =>
  fixture(async (base) => {
    const store = new Store(join(base, 'data'));
    try {
      const { limitExecution, ...legacy } = store.config();
      assert.equal(limitExecution, false);
      assert.equal(legacy.maxTurns, 16);
      assert.equal(legacy.timeoutMs, 300_000);
      store.setConfig(legacy);
      assert.equal(store.config().limitExecution, false);
      store.setConfig({ ...legacy, maxTurns: 40 });
      assert.equal(store.config().limitExecution, true);
      store.setConfig({ ...store.config(), limitExecution: false });
      assert.equal(store.config().limitExecution, false);
      assert.equal(store.config().maxTurns, 40);
      store.setConfig({ ...legacy, limitExecution: true });
      assert.equal(store.config().limitExecution, true);
    } finally {
      store.close();
    }
  }));

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
      const searchFiles = await request(`/api/projects/${p.id}/files?query=note`);
      assert.equal(searchFiles.items.length, 1);
      assert.equal(searchFiles.items[0].name, 'note.txt');
      assert.equal(searchFiles.items[0].path, 'note.txt');
      assert.equal(searchFiles.items[0].isDirectory, false);
      await mkdir(join(project, 'src', 'components'), { recursive: true });
      await writeFile(
        join(project, 'src', 'components', 'button.tsx'),
        'export const Button = () => null;\n',
      );
      const searchDirs = await request(`/api/projects/${p.id}/files?query=src/`);
      assert.ok(
        searchDirs.items.some(
          (item: { name: string; isDirectory: boolean }) =>
            item.name === 'components' && item.isDirectory,
        ),
      );
      const searchSubFiles = await request(`/api/projects/${p.id}/files?query=src/components/`);
      assert.ok(
        searchSubFiles.items.some(
          (item: { name: string; isDirectory: boolean }) =>
            item.name === 'button.tsx' && !item.isDirectory,
        ),
      );
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
      const sharedRun = (
        await request(
          `/api/sessions/${s2.id}/messages`,
          'POST',
          { text: 'independent run in the same project', idempotencyKey: randomUUID() },
          202,
        )
      ).run;
      assert.equal(starts, 2);
      assert.equal(sharedRun.sessionId, s2.id);
      assert.equal(app.store.get('runs', run.id).status, 'running');
      await request(`/api/runs/${sharedRun.id}/stop`, 'POST', {});
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
      const shellId = run.id + ':shell-output';
      const stdout = 'line\n'.repeat(7000);
      const stderr = '末行错误详情';
      const receipt = JSON.stringify({ stdout, stderr, interrupted: false });
      app.store.put('tools', {
        ...app.store.get('tools', toolId),
        id: shellId,
        name: 'Bash',
        output: receipt.slice(0, 32000),
        outputLength: receipt.length,
      });
      app.files.saveOutput(shellId, receipt);
      const display = `stdout\n${stdout}\n\nstderr\n${stderr}`;
      const urlBase = `/api/tools/${encodeURIComponent(shellId)}/output?view=display`;
      const one = await request(`${urlBase}&limit=20000`);
      const two = await request(`${urlBase}&limit=20000&offset=${one.nextOffset}`);
      assert.equal(one.total, display.length);
      assert.equal(one.text + two.text, display);
      assert.equal(two.nextOffset, null);
      assert.equal(await app.files.toolOutput(shellId), receipt);
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

test('automatic approval resolves all operation kinds without waiting and still checks the file baseline and cancellation', async () =>
  fixture(async (base, project) => {
    const store = new Store(join(base, 'data'));
    const service = new PermissionService(store);
    const run = store.put('runs', { ...runData(), approvalMode: 'automatic' });
    const request = (
      operation: Omit<Parameters<PermissionService['request']>[2], 'toolCallId'>,
      signal: AbortSignal,
    ) => {
      const tool = store.put('tools', {
        id: randomUUID(),
        runId: run.id,
        sessionId: run.sessionId,
        name: operation.kind,
        inputSummary: '',
        output: '',
        status: 'running',
        startedAt: now(),
        endedAt: null,
      });
      return service.request(run, project, { ...operation, toolCallId: tool.id }, signal);
    };
    try {
      const signal = new AbortController().signal;
      for (const kind of ['command', 'mcp', 'browser'] as const) {
        const decision = await request({ kind, command: 'fixture', reason: 'test' }, signal);
        assert.equal(decision.status, 'allowed');
        assert.equal(decision.decisionSource, 'automatic');
      }
      for (const kind of ['write', 'edit', 'delete'] as const) {
        const decision = await request(
          {
            kind,
            path: 'note.txt',
            before: 'ORIGINAL\n',
            after: kind === 'delete' ? null : 'new',
            reason: 'test',
          },
          signal,
        );
        assert.equal(decision.status, 'allowed');
        assert.equal(decision.decisionSource, 'automatic');
      }
      await assert.rejects(
        request(
          { kind: 'edit', path: 'note.txt', before: 'STALE', after: 'new', reason: 'test' },
          signal,
        ),
        { code: 'OPERATION_CHANGED' },
      );
      const controller = new AbortController();
      const pending = request(
        { kind: 'delete', path: 'note.txt', before: 'ORIGINAL\n', reason: 'test' },
        controller.signal,
      );
      controller.abort();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal(store.get('runs', run.id).status, 'running');
      assert.equal(
        store.list('permissions').filter(({ status }) => status === 'allowed').length,
        6,
      );
      assert.equal(store.list('permissions').filter(({ status }) => status === 'denied').length, 1);
      const { events } = store.runHistory(run.id);
      assert.equal(events.length, 7);
      assert.ok(
        events.every(
          (event) =>
            event.type === 'permission.resolved' && event.payload.decisionSource === 'automatic',
        ),
      );
    } finally {
      service.cancelRun(run.id);
      store.close();
    }
  }));

test('a cross-project MCP approval cannot be decided by automatic mode', async () =>
  fixture(async (base, project) => {
    const store = new Store(join(base, 'data'));
    const service = new PermissionService(store);
    const run = store.put('runs', { ...runData(), approvalMode: 'automatic' });
    const tool = store.put('tools', {
      id: randomUUID(),
      runId: run.id,
      sessionId: run.sessionId,
      name: 'shared-mcp',
      inputSummary: '',
      output: '',
      status: 'running',
      startedAt: now(),
      endedAt: null,
    });
    try {
      const pending = service.request(
        run,
        project,
        {
          toolCallId: tool.id,
          kind: 'mcp',
          command: 'fixture',
          reason: 'test',
          requireManual: true,
        },
        AbortSignal.timeout(2000),
      );
      const [permission] = store.list('permissions');
      assert.ok(permission);
      assert.equal(permission.status, 'pending');
      assert.equal(store.get('runs', run.id).status, 'awaiting_permission');
      await service.decide(permission.id, 'allow', permission.version);
      const result = await pending;
      assert.equal(result.status, 'allowed');
      assert.notEqual(result.decisionSource, 'automatic');
    } finally {
      service.cancelRun(run.id);
      store.close();
    }
  }));

test('automation is explicit for one edit run, participates in idempotency, and does not survive retry', async () =>
  fixture(async (base, project) => {
    const app = await createApp({
      root: source,
      data: join(base, 'data'),
      runnerFactory: (store) => ({
        start(run) {
          store.update('runs', run.id, { status: 'stopped', endedAt: now() });
        },
        stop() {},
        async shutdown() {},
      }),
    });
    try {
      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const url = `http://127.0.0.1:${address.port}`;
      const boot = await fetch(url + '/api/bootstrap').then((res) => res.json());
      const post = async (path: string, body: unknown, expected: number, method = 'POST') => {
        const res = await fetch(url + path, {
          method,
          headers: { 'content-type': 'application/json', 'x-atelier-token': boot.csrfToken },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        assert.equal(res.status, expected, JSON.stringify(data));
        return data;
      };
      const { project: bound } = await post('/api/projects', { path: project }, 201);
      const { session } = await post('/api/sessions', { projectId: bound.id }, 201);
      const route = `/api/sessions/${session.id}/messages`;
      const message = {
        text: 'fixture',
        mode: 'edit',
        approvalMode: 'automatic',
        maxSearchChargeFen: 500,
        idempotencyKey: randomUUID(),
      };
      const { run } = await post(route, message, 202);
      assert.equal(run.approvalMode, 'automatic');
      assert.equal(run.maxSearchChargeFen, 500);
      assert.equal(app.store.get('sessions', session.id).draft.mode, 'readonly');
      assert.equal((await post(route, message, 202)).run.id, run.id);
      assert.equal(
        (await post(route, { ...message, maxSearchChargeFen: 501 }, 409)).error.code,
        'IDEMPOTENCY_CONFLICT',
      );
      assert.equal(
        (await post(route, { ...message, mode: 'readonly', idempotencyKey: randomUUID() }, 400))
          .error.code,
        'AUTOMATION_MODE_INVALID',
      );
      const sessionRoute = `/api/sessions/${session.id}`;
      const automaticDraft = { ...session.draft, mode: 'edit', approvalMode: 'automatic' };
      await post(sessionRoute, { draft: automaticDraft }, 200, 'PATCH');
      await post(route, { ...message, idempotencyKey: randomUUID() }, 202);
      assert.equal(app.store.get('sessions', session.id).draft.approvalMode, 'automatic');
      const { run: retry } = await post(
        `/api/runs/${run.id}/retry`,
        { idempotencyKey: randomUUID() },
        202,
      );
      assert.equal(retry.mode, 'readonly');
      assert.equal(retry.approvalMode, undefined);
      assert.equal(retry.maxSearchChargeFen, undefined);
      const savedDraft = app.store.get('sessions', session.id).draft;
      assert.equal(savedDraft.mode, 'edit');
      assert.equal(savedDraft.approvalMode, 'automatic');
      await post(sessionRoute, { draft: { ...session.draft, mode: 'edit' } }, 200, 'PATCH');
      assert.equal(app.store.get('sessions', session.id).draft.approvalMode, undefined);
    } finally {
      await app.close();
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
    store.put('sessions', {
      id: run.sessionId,
      projectId: run.projectId,
      title: 'Recovered session',
      status: 'active',
      sdkSessionId: randomUUID(),
      sdkConfigKey: 'before-crash',
      createdAt: now(),
      updatedAt: now(),
      draft: emptyDraft(),
    });
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
