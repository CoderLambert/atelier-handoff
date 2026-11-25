/**
 * @file 回归本机信任会话运行前台子代理时的插话。
 * @implementation 使用真实 Claude SDK 和回环模型验证同批交接、消息送达、工具归属及报告收尾。
 * @updated 2026-11-25T23:48:00+08:00
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
  SendSessionMessageResult,
  SessionMessageQueue,
  ToolCall,
} from '../shared/types.js';
import { subagentInsertionFixture } from './fixtures/subagent-insertion.js';

for (const stopOne of [false, true])
  test(
    stopOne
      ? 'stopping one background subagent preserves the other report and parent conversation'
      : 'native insertion releases foreground Agent tools and delivers both reports after the new message',
    { skip: process.platform !== 'linux', timeout: 45_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'atelier-subagent-insertion-'));
      const project = join(directory, 'project');
      await mkdir(project);
      const fixture = subagentInsertionFixture(project);
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
        const trace = () => request<{ run: Run; tools: ToolCall[] }>('/api/runs/' + run.id);
        const batch = await waitFor(async () => {
          const { subagents } = await snapshot();
          if (subagents.length === 2 && fixture.children.every(({ started }) => started))
            return subagents;
        }, 'two simultaneous foreground subagents');
        const { queuedMessage } = await send(fixture.steer);
        assert.ok(queuedMessage);
        assert.equal(queuedMessage.insertion, 'live');
        assert.ok(fixture.parentInputs.every((text) => !text.includes(fixture.steer)));
        await request(path + '/message-queue/' + queuedMessage.id + '/insert', 'POST', {
          runId: run.id,
          mode: 'live',
        });
        const assistantReply = (reply: string) =>
          waitFor(
            async () => (await snapshot()).messages.find((message) => message.text.includes(reply)),
            reply,
          );
        assert.equal((await assistantReply(fixture.acknowledgement)).runId, run.id);
        assert.ok((await snapshot()).subagents.every(({ status }) => status === 'running'));
        assert.ok(
          (await trace()).tools
            .filter(({ name }) => name === 'Agent')
            .every(({ status }) => status === 'running'),
        );
        assert.equal((await trace()).run.status, 'running');

        assert.ok((await send(fixture.ordinary)).queuedMessage);
        assert.equal((await assistantReply(fixture.queuedAcknowledgement)).runId, run.id);
        const toStop = stopOne ? fixture.children[1] : undefined;
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
