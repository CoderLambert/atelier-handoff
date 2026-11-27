/**
 * @file 测试定时任务时间计算、调度器补跑/防重/并发公平、高权限审批与 HTTP 接口闭环。
 * @implementation 使用隔离临时目录、真实 SQLite 迁移 v12、注入假时钟与替身 runner 验证核心不变量。
 * @updated 2026-11-27T13:38:00+08:00
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AppError,
  emptyDraft,
  now,
  SCHEDULE_CONSECUTIVE_FAILURE_LIMIT,
  type Run,
  type Session,
} from '../shared/types.js';
import { AgentProfiles } from '../server/agent-profiles.js';
import { createApp } from '../server/app.js';
import { ProjectExtensions } from '../server/extensions.js';
import { buildRunMcpTools } from '../server/modules/runs/mcp-tools/index.js';
import type { RequestedOperation } from '../server/permissions.js';
import { desktopHostSystemResumeSchema, desktopHostVersion } from '../shared/desktop-host.js';
import {
  createScheduleScheduler,
  shouldNotifyScheduledRun,
} from '../server/modules/schedules/scheduler.js';
import { createScheduleService } from '../server/modules/schedules/service.js';
import { computeNextRunAt, normalizeTiming } from '../server/modules/schedules/timing.js';
import { Store } from '../server/store.js';

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-schedules-'));
  const projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const store = new Store(join(dir, 'data'));
  const extensions = new ProjectExtensions(store, false);
  const agents = new AgentProfiles(store, extensions);
  const project = store.put('projects', {
    id: 'proj-1',
    name: 'Demo',
    path: projectDir,
    branch: 'main',
    available: true,
    createdAt: now(),
  });
  const session = store.put('sessions', {
    id: 'sess-1',
    projectId: project.id,
    title: 'Main Session',
    status: 'active',
    sdkSessionId: null,
    createdAt: now(),
    updatedAt: now(),
    draft: emptyDraft(),
  });
  return {
    dir,
    projectDir,
    store,
    agents,
    project,
    session,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeRun(id: string, sessionId: string, projectId: string, status: Run['status']): Run {
  const at = now();
  return {
    id,
    sessionId,
    projectId,
    prompt: 'test',
    status,
    mode: 'readonly',
    createdAt: at,
    startedAt: at,
    endedAt: status === 'running' ? null : at,
    reason: null,
    error: null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config: {
      gateway: 'http://127.0.0.1:1',
      model: 'test',
      effort: 'medium',
      timeoutMs: 60_000,
      maxTurns: 20,
      managedGateway: false,
    },
  };
}

test('timing: computes daily, weekly, cron, interval and DST transitions accurately', () => {
  const base = new Date('2026-11-27T00:30:00.000Z');
  const daily = computeNextRunAt(
    { kind: 'daily', time: '09:00', everyDays: 1 },
    'Asia/Shanghai',
    base,
  );
  assert.equal(daily, '2026-11-27T01:00:00.000Z');

  const weekly = computeNextRunAt(
    { kind: 'weekly', time: '09:00', weekdays: [1, 3, 5] },
    'Asia/Shanghai',
    new Date('2026-11-27T01:00:00.000Z'),
  );
  assert.equal(weekly, '2026-11-30T01:00:00.000Z');

  const dstNext = computeNextRunAt(
    { kind: 'cron', expression: '30 2 * * *' },
    'America/New_York',
    new Date('2026-03-08T06:00:00.000Z'),
  );
  assert.ok(dstNext);
  assert.ok(new Date(dstNext).getTime() > new Date('2026-03-08T06:00:00.000Z').getTime());

  assert.throws(
    () => normalizeTiming({ kind: 'interval', everySeconds: 120 }, 'UTC', 'new', base),
    (error: unknown) => error instanceof AppError && error.code === 'SCHEDULE_INVALID_TIMING',
  );
});

test('service: paused task stays paused on edit and enforces optimistic concurrency', () => {
  const fixture = createFixture();
  try {
    let currentTime = new Date('2026-11-27T08:00:00.000Z');
    const service = createScheduleService({
      store: fixture.store,
      agents: fixture.agents,
      clock: () => currentTime,
    });
    const created = service.create({
      projectId: fixture.project.id,
      title: 'Branch sync',
      prompt: 'Check git status',
      timing: { kind: 'daily', time: '09:00', everyDays: 1 },
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(created.status, 'active');

    currentTime = new Date('2026-11-27T08:01:00.000Z');
    const paused = service.update(created.id, { status: 'paused' });
    assert.equal(paused.status, 'paused');

    currentTime = new Date('2026-11-27T08:02:00.000Z');
    const edited = service.update(created.id, {
      expectedUpdatedAt: paused.updatedAt,
      timing: { kind: 'daily', time: '10:00', everyDays: 1 },
    });
    assert.equal(edited.status, 'paused');

    assert.throws(
      () =>
        service.update(created.id, {
          expectedUpdatedAt: paused.updatedAt,
          title: 'Stale write',
        }),
      (error: unknown) => error instanceof AppError && error.code === 'SCHEDULE_CONFLICT',
    );
  } finally {
    fixture.cleanup();
  }
});

test('scheduler: enforces misfire coalescing, slot reservation, and consecutive failure circuit breaker', async () => {
  const fixture = createFixture();
  try {
    let currentTime = new Date('2026-11-27T00:00:00.000Z');
    const service = createScheduleService({
      store: fixture.store,
      agents: fixture.agents,
      clock: () => currentTime,
    });
    const task = service.create({
      projectId: fixture.project.id,
      title: 'Sync check',
      prompt: 'Check git sync',
      timing: { kind: 'interval', everySeconds: 300 },
      timeZone: 'UTC',
      targetMode: 'new_once',
      misfirePolicy: 'run_once',
    });

    const dispatchedRuns: Array<{ sessionId: string; raw: unknown }> = [];
    let shouldFail = false;
    let sessionSeq = 0;
    const scheduler = createScheduleScheduler({
      store: fixture.store,
      clock: () => currentTime,
      sameSessionRunning: () => false,
      isShuttingDown: () => false,
      createSession: async (input) => {
        sessionSeq += 1;
        const created: Session = {
          id: `auto-sess-${sessionSeq}`,
          projectId: input.projectId,
          title: input.title ?? 'Auto',
          origin: input.origin,
          status: 'active',
          sdkSessionId: null,
          createdAt: currentTime.toISOString(),
          updatedAt: currentTime.toISOString(),
          draft: emptyDraft(),
        };
        fixture.store.put('sessions', created);
        return created;
      },
      createRun: async (sessionId, raw) => {
        if (shouldFail) throw new AppError('SDK_UNAVAILABLE', 'gateway offline', 503);
        dispatchedRuns.push({ sessionId, raw });
        const run = makeRun(
          `run-${dispatchedRuns.length}`,
          sessionId,
          fixture.project.id,
          'completed',
        );
        fixture.store.put('runs', run);
        return { run };
      },
    });

    // Reserve 1 interactive slot: with 2 active runs already present, scheduled tick defers
    fixture.store.put(
      'runs',
      makeRun('active-1', fixture.session.id, fixture.project.id, 'running'),
    );
    fixture.store.put(
      'runs',
      makeRun('active-2', fixture.session.id, fixture.project.id, 'running'),
    );
    currentTime = new Date('2026-11-27T00:20:00.000Z');
    await scheduler.tick();
    assert.equal(dispatchedRuns.length, 0);

    // Clear active runs -> misfire run_once coalesces into 1 dispatch
    fixture.store.update('runs', 'active-1', {
      status: 'completed',
      endedAt: currentTime.toISOString(),
    });
    fixture.store.update('runs', 'active-2', {
      status: 'completed',
      endedAt: currentTime.toISOString(),
    });
    await scheduler.tick();
    assert.equal(dispatchedRuns.length, 1);
    assert.equal(service.get(task.id).targetSessionId, 'auto-sess-1');
    assert.equal(service.get(task.id).nextRunAt, '2026-11-27T00:25:00.000Z');

    // Manual runNow does NOT shift nextRunAt
    const manual = await scheduler.runNow(task.id);
    assert.equal(manual.triggerKind, 'manual');
    assert.equal(service.get(task.id).nextRunAt, '2026-11-27T00:25:00.000Z');

    // 5 consecutive failures auto-pause task
    shouldFail = true;
    for (let i = 0; i < SCHEDULE_CONSECUTIVE_FAILURE_LIMIT; i += 1) {
      await scheduler.runNow(task.id);
    }
    const pausedByFailures = service.get(task.id);
    assert.equal(pausedByFailures.status, 'paused');
    assert.equal(pausedByFailures.pauseReason, 'consecutive_failures');

    await scheduler.stop();
  } finally {
    fixture.cleanup();
  }
});

test('mcp tools: edit + automatic scheduled task creation requires manual approval', async () => {
  const fixture = createFixture();
  try {
    const service = createScheduleService({ store: fixture.store, agents: fixture.agents });
    const approvals: RequestedOperation[] = [];
    const { mcpTools } = buildRunMcpTools({
      run: makeRun('run-mcp', fixture.session.id, fixture.project.id, 'running'),
      projectId: fixture.project.id,
      workingDirectory: fixture.projectDir,
      native: false,
      automaticApproval: true,
      allowed: () => true,
      verifyCurrent: () => undefined,
      verifyDispatch: async () => undefined,
      signal: new AbortController().signal,
      toolSignal: () => new AbortController().signal,
      branchSignal: () => undefined,
      toolContext: new AsyncLocalStorage<AbortSignal>(),
      toolWork: new Map(),
      commands: new Set(),
      sendInsertion: () => undefined,
      claimTool: () => ({ id: 'tool-1' }),
      finishTool: () => undefined,
      cleanError: (error) => (error instanceof Error ? error.message : String(error)),
      pagedOutputIds: new Set(),
      updatePlan: () => undefined,
      getTool: () => {
        throw new Error('unused');
      },
      getExtension: () => {
        throw new Error('unused');
      },
      event: () => undefined,
      approve: async (operation) => {
        approvals.push(operation);
        return {};
      },
      writeProject: async (effect) => effect(),
      artifacts: {
        publish: async () => {
          throw new Error('unused');
        },
        publishScreenshot: async () => {
          throw new Error('unused');
        },
        toolOutput: async () => '',
      },
      mcp: [],
      skillBindings: [],
      readSkillBindings: () => [],
      weatherEnabled: false,
      packages: new Map(),
      storage: fixture.dir,
      executePackage: async () => ({}),
      schedules: {
        ...service,
        trigger: async () => {
          throw new Error('unused in privilege test');
        },
      },
    });

    const createTool = mcpTools.find((item) => item.name === 'create_scheduled_task');
    assert.ok(createTool);

    // Readonly task creates without manual approval
    await createTool.handler(
      {
        title: 'Readonly sync check',
        prompt: 'Check git status',
        timing: { kind: 'daily', time: '09:00', everyDays: 1 },
        targetMode: 'new_once',
        mode: 'readonly',
        maxSearchChargeFen: 0,
        misfirePolicy: 'run_once',
        overlapPolicy: 'skip',
        notifyPolicy: 'on_error',
      },
      {},
    );
    assert.equal(approvals.length, 0);

    // High-privilege edit + automatic MUST request manual approval
    await createTool.handler(
      {
        title: 'Auto fixer',
        prompt: 'Format files',
        timing: { kind: 'daily', time: '09:00', everyDays: 1 },
        targetMode: 'new_once',
        mode: 'edit',
        approvalMode: 'automatic',
        maxSearchChargeFen: 0,
        misfirePolicy: 'run_once',
        overlapPolicy: 'skip',
        notifyPolicy: 'on_error',
      },
      {},
    );
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.requireManual, true);
  } finally {
    fixture.cleanup();
  }
});

test('http routes: full CRUD + runNow + history flow on live local server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-schedules-http-'));
  const projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const app = await createApp({
    root: process.cwd(),
    data: join(dir, 'data'),
    runnerFactory: (store) => ({
      start(run) {
        const finishedAt = now();
        store.update('runs', run.id, {
          status: 'completed',
          startedAt: finishedAt,
          endedAt: finishedAt,
        });
        store.event(run.id, run.sessionId, 'run.finished', { status: 'completed' });
      },
      stop() {},
      async shutdown() {},
    }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const boot = (await (await fetch(`${base}/api/bootstrap`)).json()) as { csrfToken: string };
    const headers = {
      'Content-Type': 'application/json',
      'X-Atelier-Token': boot.csrfToken,
    };

    const project = app.store.put('projects', {
      id: 'proj-http',
      name: 'HTTP Demo',
      path: projectDir,
      branch: 'main',
      available: true,
      createdAt: now(),
    });

    const createdRes = await fetch(`${base}/api/schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId: project.id,
        title: 'Daily git check',
        prompt: 'Check git status',
        timing: { kind: 'daily', time: '09:00', everyDays: 1 },
        timeZone: 'Asia/Shanghai',
      }),
    });
    assert.equal(createdRes.status, 201);
    const { task } = (await createdRes.json()) as { task: { id: string; updatedAt: string } };

    const runRes = await fetch(`${base}/api/schedules/${task.id}/run`, {
      method: 'POST',
      headers,
    });
    assert.equal(runRes.status, 201);

    const historyRes = await fetch(`${base}/api/schedules/${task.id}/runs`);
    assert.equal(historyRes.status, 200);
    const history = (await historyRes.json()) as {
      items: Array<{ triggerKind: string; status: string }>;
    };
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0]?.triggerKind, 'manual');
    assert.equal(history.items[0]?.status, 'completed');

    const delRes = await fetch(`${base}/api/schedules/${task.id}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(delRes.status, 200);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notifications and system-resume IPC: respects notifyPolicy and validates resume schema', () => {
  assert.equal(shouldNotifyScheduledRun('never', false, 'ATTENTION: disk full'), false);
  assert.equal(shouldNotifyScheduledRun('always', true, 'all good'), true);
  assert.equal(shouldNotifyScheduledRun('on_error', true, 'ATTENTION: ignored'), false);
  assert.equal(shouldNotifyScheduledRun('on_error', false, 'failed'), true);
  assert.equal(shouldNotifyScheduledRun('on_attention', true, 'HEARTBEAT_OK'), false);
  assert.equal(
    shouldNotifyScheduledRun('on_attention', true, 'Summary\nATTENTION: behind by 3 commits'),
    true,
  );
  assert.equal(shouldNotifyScheduledRun('on_attention', false, 'error'), true);

  assert.equal(
    desktopHostSystemResumeSchema.safeParse({
      protocolVersion: desktopHostVersion,
      type: 'atelier-host:system-resume',
    }).success,
    true,
  );
  assert.equal(
    desktopHostSystemResumeSchema.safeParse({
      protocolVersion: desktopHostVersion,
      type: 'atelier-host:unknown',
    }).success,
    false,
  );
});

test('unified trigger: manual timing, slug uniqueness, input injection, idempotency, paused gate, and cycle/depth guards', async () => {
  const fixture = createFixture();
  try {
    const service = createScheduleService({
      store: fixture.store,
      agents: { requireReady: () => ({}) as never },
    });

    const manualTask = service.create({
      projectId: fixture.project.id,
      slug: 'release-check',
      title: 'Release check',
      prompt: 'Run release checklist',
      timing: { kind: 'manual' },
      timeZone: 'Asia/Shanghai',
    });
    assert.equal(manualTask.nextRunAt, null);
    assert.equal(manualTask.slug, 'release-check');
    assert.equal(manualTask.remoteTriggerEnabled, false);
    assert.equal(manualTask.hasTriggerToken, false);

    // Duplicate slug within same project must fail with 409
    assert.throws(
      () =>
        service.create({
          projectId: fixture.project.id,
          slug: 'release-check',
          title: 'Duplicate slug',
          prompt: 'Should fail',
          timing: { kind: 'manual' },
          timeZone: 'Asia/Shanghai',
        }),
      (error: unknown) => (error as { code?: string }).code === 'SCHEDULE_SLUG_CONFLICT',
    );

    const dispatchedTexts: string[] = [];
    const dispatchedMeta: Array<Record<string, unknown> | undefined> = [];
    const scheduler = createScheduleScheduler({
      store: fixture.store,
      createSession: async ({ projectId, title }) =>
        fixture.store.put('sessions', {
          id: `sess-${Math.random().toString(36).slice(2, 8)}`,
          projectId,
          title: title ?? 'Automation',
          status: 'active',
          origin: 'schedule',
          sdkSessionId: null,
          draft: { text: '', contextPaths: [], attachmentIds: [], mode: 'readonly' },
          createdAt: now(),
          updatedAt: now(),
        }),
      createRun: (async (
        sessionId: string,
        request: { text: string; scheduleMeta?: Record<string, unknown> },
      ) => {
        dispatchedTexts.push(request.text);
        dispatchedMeta.push(request.scheduleMeta);
        const runId = `run-${dispatchedTexts.length}`;
        const run = fixture.store.put('runs', {
          id: runId,
          sessionId,
          status: 'completed',
          mode: 'readonly',
          prompt: request.text,
          createdAt: now(),
          startedAt: now(),
          endedAt: now(),
          error: null,
          plan: [],
        } as never);
        return { run };
      }) as never,
      sameSessionRunning: () => false,
      isShuttingDown: () => false,
    });

    // Trigger by slug with temporary input + idempotencyKey
    const first = await scheduler.trigger('release-check', {
      triggerKind: 'agent',
      projectId: fixture.project.id,
      input: 'Focus on auth migration',
      idempotencyKey: 'pr-42-check',
      triggerSource: 'session:sess-caller',
      chainDepth: 1,
      visitedTaskIds: ['upstream-task'],
    });
    assert.equal(first.deduplicated, false);
    assert.equal(first.run.triggerKind, 'agent');
    assert.equal(first.run.triggerSource, 'session:sess-caller');
    assert.equal(first.run.chainDepth, 1);
    assert.equal(first.run.idempotencyKey, 'pr-42-check');
    assert.match(first.run.promptSnapshot, /Run release checklist/);
    assert.match(first.run.promptSnapshot, /Focus on auth migration/);
    // Original task prompt must remain untouched
    assert.equal(service.get(manualTask.id).prompt, 'Run release checklist');
    assert.equal(service.get(manualTask.id).status, 'active');

    // Duplicate idempotencyKey returns existing run without re-dispatching
    const duplicate = await scheduler.trigger('release-check', {
      triggerKind: 'agent',
      projectId: fixture.project.id,
      input: 'Different text ignored',
      idempotencyKey: 'pr-42-check',
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.run.id, first.run.id);
    assert.equal(dispatchedTexts.length, 1);

    // Cycle detection blocks self/loop trigger
    await assert.rejects(
      () =>
        scheduler.trigger('release-check', {
          triggerKind: 'agent',
          projectId: fixture.project.id,
          chainDepth: 1,
          visitedTaskIds: [manualTask.id],
        }),
      (error: unknown) => (error as { code?: string }).code === 'SCHEDULE_CYCLE_DETECTED',
    );

    // Depth limit blocks deep chain (> 3)
    await assert.rejects(
      () =>
        scheduler.trigger('release-check', {
          triggerKind: 'agent',
          projectId: fixture.project.id,
          chainDepth: 4,
          visitedTaskIds: ['t1', 't2', 't3'],
        }),
      (error: unknown) => (error as { code?: string }).code === 'SCHEDULE_CHAIN_DEPTH_EXCEEDED',
    );

    // Paused task rejects external/agent trigger unless allowPaused is true
    service.update(manualTask.id, { status: 'paused' });
    await assert.rejects(
      () =>
        scheduler.trigger('release-check', {
          triggerKind: 'agent',
          projectId: fixture.project.id,
        }),
      (error: unknown) => (error as { code?: string }).code === 'SCHEDULE_PAUSED',
    );
    const manualOverride = await scheduler.runNow('release-check');
    assert.equal(manualOverride.triggerKind, 'manual');
    assert.equal(dispatchedTexts.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test('http remote trigger narrow endpoint: Bearer token auth, idempotency, cross-site block, rotation & revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-schedules-remote-'));
  const projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const app = await createApp({
    root: process.cwd(),
    data: join(dir, 'data'),
    desktopPairing: 'secret-desktop-pairing',
    runnerFactory: (store) => ({
      start(run) {
        const finishedAt = now();
        store.update('runs', run.id, {
          status: 'completed',
          startedAt: finishedAt,
          endedAt: finishedAt,
        });
        store.event(run.id, run.sessionId, 'run.finished', { status: 'completed' });
      },
      stop() {},
      async shutdown() {},
    }),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (app.server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const pairingHeaders = { 'X-Atelier-Desktop-Pairing': 'secret-desktop-pairing' };
    const boot = (await (
      await fetch(`${base}/api/bootstrap`, { headers: pairingHeaders })
    ).json()) as { csrfToken: string };
    const adminHeaders = {
      'Content-Type': 'application/json',
      'X-Atelier-Token': boot.csrfToken,
      ...pairingHeaders,
    };

    const project = app.store.put('projects', {
      id: 'proj-remote',
      name: 'Remote Demo',
      path: projectDir,
      branch: 'main',
      available: true,
      createdAt: now(),
    });

    const createRes = await fetch(`${base}/api/schedules`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        projectId: project.id,
        slug: 'nightly-deploy-check',
        title: 'Nightly check',
        prompt: 'Check deployment health',
        timing: { kind: 'manual' },
      }),
    });
    assert.equal(createRes.status, 201);
    const { task } = (await createRes.json()) as { task: { id: string; slug: string } };

    // Before enabling token, remote endpoint returns 401
    const unauthRes = await fetch(`${base}/api/triggers/schedules/${task.slug}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer atk_invalid' },
    });
    assert.equal(unauthRes.status, 401);

    // Issue token via admin endpoint
    const issueRes = await fetch(`${base}/api/schedules/${task.id}/trigger-token`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(issueRes.status, 201);
    const { token: token1, task: enabledTask } = (await issueRes.json()) as {
      token: string;
      task: { remoteTriggerEnabled: boolean; hasTriggerToken: boolean };
    };
    assert.ok(token1.startsWith('atk_'));
    assert.equal(enabledTask.remoteTriggerEnabled, true);
    assert.equal(enabledTask.hasTriggerToken, true);

    // Browser cross-site request is blocked even with valid token
    const corsBlocked = await fetch(`${base}/api/triggers/schedules/${task.slug}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        Origin: 'https://evil.example',
      },
    });
    assert.equal(corsBlocked.status, 403);

    // Remote trigger works WITHOUT x-atelier-token and WITHOUT desktopPairing!
    const triggerRes = await fetch(`${base}/api/triggers/schedules/${task.slug}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'remote-evt-1',
      },
      body: JSON.stringify({ input: 'Triggered from phone shortcut' }),
    });
    assert.equal(triggerRes.status, 201);
    const firstTrigger = (await triggerRes.json()) as {
      run: { id: string; triggerKind: string; promptSnapshot: string; status: string };
      deduplicated: boolean;
    };
    assert.equal(firstTrigger.deduplicated, false);
    assert.equal(firstTrigger.run.triggerKind, 'webhook');
    assert.equal(firstTrigger.run.status, 'completed');
    assert.match(firstTrigger.run.promptSnapshot, /Triggered from phone shortcut/);

    // Same Idempotency-Key deduplicates (200)
    const dedupRes = await fetch(`${base}/api/triggers/schedules/${task.slug}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token1}`,
        'Idempotency-Key': 'remote-evt-1',
      },
    });
    assert.equal(dedupRes.status, 200);
    const dedupBody = (await dedupRes.json()) as { run: { id: string }; deduplicated: boolean };
    assert.equal(dedupBody.deduplicated, true);
    assert.equal(dedupBody.run.id, firstTrigger.run.id);

    // Rotate token -> old token immediately rejected
    const rotateRes = await fetch(`${base}/api/schedules/${task.id}/trigger-token`, {
      method: 'POST',
      headers: adminHeaders,
    });
    assert.equal(rotateRes.status, 201);
    const { token: token2 } = (await rotateRes.json()) as { token: string };
    assert.notEqual(token2, token1);

    const oldTokenRes = await fetch(`${base}/api/triggers/schedules/${task.slug}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token1}` },
    });
    assert.equal(oldTokenRes.status, 401);

    // Revoke token -> new token also rejected
    const revokeRes = await fetch(`${base}/api/schedules/${task.id}/trigger-token`, {
      method: 'DELETE',
      headers: adminHeaders,
    });
    assert.equal(revokeRes.status, 200);

    const revokedRes = await fetch(`${base}/api/triggers/schedules/${task.slug}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token2}` },
    });
    assert.equal(revokedRes.status, 401);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
