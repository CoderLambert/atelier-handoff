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
import { createScheduleScheduler } from '../server/modules/schedules/scheduler.js';
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
      schedules: service,
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
