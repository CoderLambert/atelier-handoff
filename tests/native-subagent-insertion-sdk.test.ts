/**
 * @file 回归本机信任会话的子代理派发与插话。
 * @implementation 使用真实 Claude SDK 和回环模型验证前后台派发、输入回执、单分支停止及汇总期间插话。
 * @updated 2026-11-26T23:08:48+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { SubagentRun } from '../server/subagent-run.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import type { Subagent } from '../shared/subagents.js';
import type {
  Message,
  Run,
  RunEvent,
  SendSessionMessageResult,
  SessionMessageQueue,
  ToolCall,
} from '../shared/types.js';
import { subagentInsertionFixture } from './fixtures/subagent-insertion.js';

const scenarios = [
  [
    'foreground',
    'native insertion releases foreground Agent tools and delivers both reports after the new message',
  ],
  [
    'stop-one',
    'stopping one background subagent preserves the other report and parent conversation',
  ],
  [
    'steered',
    'a delivered insertion frees the queue while its two new foreground tasks are still running',
  ],
  ['stop-after-delivery', 'stopping a foreground batch keeps the delivered insertion confirmed'],
  ['hold-reply', 'stopping without an SDK receipt retains the insertion for review without replay'],
  [
    'native-background',
    'native default and explicit background Agent dispatch let the parent continue before either report',
  ],
] as const;

for (const [scenario, title] of scenarios)
  test(
    title,
    {
      skip: process.platform !== 'linux' && 'The native harness requires Linux',
      timeout: 45_000,
    },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'atelier-subagent-insertion-'));
      const project = join(directory, 'project');
      await mkdir(project);
      const steered =
        scenario === 'steered' || scenario === 'stop-after-delivery' || scenario === 'hold-reply';
      const fixture = subagentInsertionFixture(
        project,
        scenario === 'hold-reply' || scenario === 'native-background'
          ? scenario
          : steered
            ? 'steered'
            : 'foreground',
      );
      const { gateway } = fixture;
      await writeFile(join(project, fixture.sampleName), fixture.sampleText);
      const oldToken = process.env.ATELIER_GATEWAY_TOKEN;
      process.env.ATELIER_GATEWAY_TOKEN = 'subagent-insertion-fixture';
      let app: Awaited<ReturnType<typeof createApp>> | undefined;
      try {
        gateway.listen(0, '127.0.0.1');
        await once(gateway, 'listening');
        const address = gateway.address();
        assert.ok(address && typeof address === 'object');
        const pairing = 'isolated-subagent-insertion';
        app = await createApp({
          root: fileURLToPath(new URL('../', import.meta.url)),
          data: join(directory, 'data'),
          desktopPairing: pairing,
          nativeExecution: true,
        });
        app.server.listen(0, '127.0.0.1');
        await once(app.server, 'listening');
        const appAddress = app.server.address();
        assert.ok(appAddress && typeof appAddress === 'object');
        const base = 'http://127.0.0.1:' + appAddress.port;
        const headers: Record<string, string> = {
          [desktopPairingHeader]: pairing,
          'content-type': 'application/json',
        };
        async function request<T>(path: string, method = 'GET', payload?: unknown, status = 200) {
          const response = await fetch(base + path, {
            method,
            headers,
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          });
          const value: unknown = await response.json();
          assert.equal(response.status, status, JSON.stringify(value));
          return value as T;
        }
        headers['x-atelier-token'] = (
          await request<{ csrfToken: string }>('/api/bootstrap')
        ).csrfToken;
        await request('/api/config', 'PATCH', {
          gateway: 'http://127.0.0.1:' + address.port,
          model: fixture.model,
          managedGateway: false,
        });
        const { project: bound } = await request<{ project: { id: string } }>(
          '/api/projects',
          'POST',
          { path: project },
          201,
        );
        const { session } = await request<{ session: { id: string } }>(
          '/api/sessions',
          'POST',
          { projectId: bound.id },
          201,
        );
        const path = '/api/sessions/' + session.id;
        const send = (text: string) =>
          request<SendSessionMessageResult>(
            path + '/messages',
            'POST',
            { text, executionPreference: 'native-v1', mode: 'edit', idempotencyKey: randomUUID() },
            202,
          );
        const snapshot = () =>
          request<{
            subagents: Subagent[];
            messages: Message[];
            messageQueue: SessionMessageQueue;
          }>(path);
        async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            assert.deepEqual(fixture.errors, []);
            const value = await read();
            if (value !== undefined) return value;
            await delay(25);
          }
          throw new Error('Timed out observing ' + label);
        }

        const { run } = await send(fixture.initial);
        assert.equal(run?.executor, 'native-v1');
        assert.ok(run);
        const trace = () =>
          request<{ run: Run; tools: ToolCall[]; events: RunEvent[] }>('/api/runs/' + run.id);
        const waitForBatch = () =>
          waitFor(async () => {
            const { subagents } = await snapshot();
            if (subagents.length === 2 && fixture.children.every(({ started }) => started))
              return subagents;
          }, 'two simultaneous foreground subagents');
        const insert = async (text: string) => {
          const { queuedMessage } = await send(text);
          assert.ok(queuedMessage);
          assert.equal(queuedMessage.insertion, 'live');
          await request(path + '/message-queue/' + queuedMessage.id + '/insert', 'POST', {
            runId: run.id,
            mode: 'live',
          });
          return queuedMessage.id;
        };
        const assistantReply = (reply: string) =>
          waitFor(
            async () => (await snapshot()).messages.find((message) => message.text.includes(reply)),
            reply,
          );
        const stopRun = async () => {
          await request('/api/runs/' + run.id + '/stop', 'POST', {});
          await waitFor(async () => {
            const { run: current } = await trace();
            if (current.endedAt) return current;
          }, 'stopped run cleanup').then(({ status }) => assert.equal(status, 'stopped'));
        };
        let steerId: string;
        if (steered) {
          await waitFor(
            async () => (fixture.parentInputs.length ? true : undefined),
            'first request held by the loopback model',
          );
          steerId = await insert(fixture.steer);
          fixture.releaseInitial();
          if (scenario === 'hold-reply') {
            await waitFor(
              async () =>
                fixture.parentInputs.some((text) => text.includes(fixture.steer))
                  ? true
                  : undefined,
              'inserted model request held before its first frame',
            );
            const beforeStop = await snapshot();
            assert.ok(
              beforeStop.messages.every(({ text }) => !text.includes(fixture.acknowledgement)),
            );
            assert.equal(beforeStop.messageQueue.items[0]?.delivery, 'sending');
            await stopRun();
            assert.deepEqual(
              (await snapshot()).messageQueue.items.map(({ id, delivery }) => [id, delivery]),
              [[steerId, 'unknown']],
            );
            assert.equal(
              fixture.parentInputs.filter((text) => text.includes(fixture.steer)).length,
              1,
            );
            return;
          }
        } else {
          if (scenario === 'native-background') {
            await assistantReply(fixture.waiting);
            assert.equal((await trace()).run.status, 'running');
          }
          await waitForBatch();
          assert.ok(fixture.parentInputs.every((text) => !text.includes(fixture.steer)));
          steerId = await insert(fixture.steer);
        }
        const batch = await waitForBatch();
        assert.equal((await assistantReply(fixture.acknowledgement)).runId, run.id);
        assert.ok((await snapshot()).subagents.every(({ status }) => status === 'running'));
        assert.ok(
          (await trace()).tools
            .filter(({ name }) => name === 'Agent')
            .every(({ status }) => status === 'running'),
        );
        assert.equal((await trace()).run.status, 'running');

        if (scenario === 'stop-after-delivery') {
          await waitFor(
            async () =>
              fixture.children.every(({ readReturned }) => readReturned) ? true : undefined,
            'both branches finished reading and are waiting to report',
          );
          await stopRun();
          assert.deepEqual((await snapshot()).messageQueue.items, []);
          assert.equal((await snapshot()).messages.filter(({ id }) => id === steerId).length, 1);
          return;
        }
        if (scenario === 'steered') {
          assert.ok(!(await snapshot()).messageQueue.items.some(({ id }) => id === steerId));
          const receipts = (await trace()).events.filter(
            ({ type }) => type === 'sdk.input_confirmed',
          );
          assert.equal(receipts.length, 1);
          assert.equal(receipts[0]?.payload.messageId, steerId);
          assert.match(String(receipts[0]?.payload.receipt), /^(replay|reply)$/u);
          await insert(fixture.ordinary);
        } else {
          assert.ok((await send(fixture.ordinary)).queuedMessage);
        }
        assert.equal((await assistantReply(fixture.queuedAcknowledgement)).runId, run.id);
        const toStop = scenario === 'stop-one' ? fixture.children[1] : undefined;
        if (toStop) {
          const target = batch.find(({ title }) => title === toStop.title);
          assert.ok(target);
          await request(
            '/api/runs/' + run.id + '/subagents/' + encodeURIComponent(target.id) + '/stop',
            'POST',
            {},
          );
          await waitFor(async () => {
            const ended = (await snapshot()).subagents.find(({ id }) => id === target.id);
            if (ended?.status === 'stopped') return ended;
          }, 'selected background subagent stops');
          assert.equal(
            (await trace()).tools.find(({ id }) => id === target.id)?.status,
            'canceled',
          );
          assert.equal((await trace()).run.status, 'running');
        }
        for (const child of fixture.children.filter((entry) => entry !== toStop)) {
          child.release();
          const ended = await waitFor(
            async () =>
              (await snapshot()).subagents.find(
                ({ title, status }) => title === child.title && status !== 'running',
              ),
            child.report,
          );
          assert.equal(ended.status, 'completed');
          assert.ok(ended.summary?.includes(child.report));
          const { tools } = await trace();
          const read = tools.find(({ id }) => id.endsWith(':' + child.readId));
          assert.equal(read?.subagentId, ended.id);
          assert.equal(read?.status, 'succeeded');
          assert.equal(tools.find(({ id }) => id === ended.id)?.status, 'succeeded');
        }
        if (scenario === 'steered') {
          await fixture.collectionStarted;
          assert.equal((await trace()).run.status, 'running');
          await insert(fixture.duringCollection);
          fixture.releaseCollection();
          assert.equal((await assistantReply(fixture.collectionAcknowledgement)).runId, run.id);
        }
        if (!toStop) assert.equal((await assistantReply(fixture.collected)).runId, run.id);
        await waitFor(async () => {
          const { run: current } = await trace();
          if (current.endedAt) return current;
        }, 'run cleanup').then(({ status }) => assert.equal(status, 'completed'));
        assert.equal((await snapshot()).messageQueue.items.length, 0);
        assert.ok(
          fixture.parentInputs.some((text) =>
            fixture.children.every((child) => text.includes(child.report) === (child !== toStop)),
          ),
        );
        if (toStop)
          assert.ok(!(await trace()).tools.some(({ id }) => id.endsWith(':' + toStop.readId)));
      } finally {
        fixture.releaseInitial();
        fixture.releaseReply();
        fixture.releaseCollection();
        for (const child of fixture.children) child.release();
        await app?.close();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        if (oldToken === undefined) delete process.env.ATELIER_GATEWAY_TOKEN;
        else process.env.ATELIER_GATEWAY_TOKEN = oldToken;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

test('an early background completion waits for the matching handoff and cannot close a sibling', () => {
  const ended: unknown[] = [];
  const tasks = new SubagentRun(
    { id: 'run', sessionId: 'workbench-session' },
    'sdk-session',
    true,
    { startSubagent() {}, finishSubagent: (...args) => ended.push(args) },
    () => {},
  );
  const first = {
    session_id: 'sdk-session',
    task_id: 'child-a',
    task_type: 'local_agent',
    run_id: 'attempt-a',
    tool_use_id: 'spawn-a',
  };
  const second = { ...first, task_id: 'child-b', run_id: 'attempt-b', tool_use_id: 'spawn-b' };
  for (const event of [first, second]) {
    tasks.reserve('run:' + event.tool_use_id, event.tool_use_id, {
      description: 'Read the isolated sample',
      prompt: 'Check the sample',
      subagent_type: 'atelier-explore',
    });
    tasks.started(event);
  }
  const terminal = { ...first, status: 'completed', summary: 'Observed report' };
  tasks.updated({ ...first, patch: { is_backgrounded: true } });
  assert.equal(tasks.notify({ ...terminal, session_id: 'another-session' }), false);
  assert.equal(tasks.notify({ ...terminal, run_id: 'older-attempt' }), false);
  assert.equal(tasks.notify({ ...terminal, tool_use_id: second.tool_use_id }), false);
  assert.equal(tasks.notify(terminal), true);
  assert.deepEqual(ended, []);
  assert.deepEqual(tasks.actor(first.task_id), { id: 'run:spawn-a', kind: 'explore' });
  tasks.report('run:spawn-a', { status: 'async_launched', agentId: first.task_id });
  assert.equal(tasks.notify(terminal), false);
  assert.deepEqual(ended, [['run:spawn-a', 'run', 'completed', 'Observed report']]);
  assert.deepEqual(tasks.actor(second.task_id), { id: 'run:spawn-b', kind: 'explore' });
});

test('a native background handoff can arrive before registration of the same task ID', () => {
  const finished: unknown[] = [];
  const tasks = new SubagentRun(
    { id: 'run', sessionId: 'workbench-session' },
    'sdk-session',
    true,
    { startSubagent() {}, finishSubagent: (...args) => finished.push(args) },
    () => {},
  );
  const args = {
    description: 'Read an isolated sample',
    prompt: 'Read and report.',
    subagent_type: 'atelier-explore',
  };
  const started = {
    session_id: 'sdk-session',
    task_type: 'local_agent',
    is_backgrounded: true,
    run_id: 'attempt-a',
  };
  for (const [call, taskId, handoffId] of [
    ['matching', 'branch-a', 'branch-a'],
    ['foreign', 'branch-b', 'other-branch'],
  ] as const) {
    const id = 'run:' + call;
    const info = { ...started, task_id: taskId, tool_use_id: call };
    assert.deepEqual(tasks.reserve(id, call, args), args);
    tasks.report(id, { status: 'async_launched', agentId: handoffId });
    assert.ok(tasks.hasBackground);
    tasks.started(info);
    tasks.notify({ ...info, status: 'completed', summary: 'Branch report' });
  }
  assert.deepEqual(finished, [
    ['run:matching', 'run', 'completed', 'Branch report'],
    ['run:foreign', 'run', 'failed', '子代理后台交接与当前任务不匹配。'],
  ]);
  assert.equal(tasks.active, false);
});
