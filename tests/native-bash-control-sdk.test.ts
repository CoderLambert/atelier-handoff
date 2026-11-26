/**
 * @file 验证锁定 Claude SDK 的原生 Bash 生命周期和会话调控。
 * @implementation 使用隔离 HTTP 工作台和回环模型核对后台回执、退出日志和逐命令停止。
 * @updated 2026-11-25T22:05:06+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { NativeBashTasks } from '../server/native-bash.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import type {
  Message,
  Run,
  SendSessionMessageResult,
  SessionMessageQueue,
  ToolCall,
} from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

test('Bash task ownership follows the SDK actor and foreground receipts survive an early task notice', async () => {
  const sdkSession = 'sdk_session';
  const bash = new NativeBashTasks(sdkSession, () => {});
  const sdkStarts = (parent: string, task: string) =>
    bash.started({
      session_id: sdkSession,
      task_type: 'local_bash',
      task_id: task,
      run_id: 'run_' + task,
      tool_use_id: 'reused_id',
      parent_task_id: parent,
      is_backgrounded: false,
    });
  bash.register('call_a', 'reused_id', 'subagent_a', 'actor_a');
  bash.register('call_b', 'reused_id', 'subagent_b', 'actor_b');
  sdkStarts('actor_b', 'bash_b');
  sdkStarts('actor_a', 'bash_a');
  const stops: string[] = [];
  const sdk = {
    async backgroundTasks() {
      throw new Error('An ambiguous tool ID must never reach the SDK');
    },
    async stopTask(id: string) {
      stops.push(id);
    },
  };
  await assert.rejects(bash.control(sdk, 'call_a', 'background'), /重叠/u);
  await bash.control(sdk, 'call_a', 'stop');
  assert.deepEqual(stops, ['bash_a']);
  const completed = {
    session_id: sdkSession,
    task_id: 'bash_a',
    run_id: 'run_bash_a',
    tool_use_id: 'reused_id',
    status: 'completed',
    output_file: '',
    summary: 'Task description',
  };
  assert.equal(bash.terminal(completed), undefined);
  assert.equal(bash.deferFailureDuringStop('call_a', 'Exit code 7'), false);
  bash.complete('call_a');
  assert.equal(bash.terminal(completed), undefined);
  const earlyBackground = {
    ...completed,
    task_id: 'bash_b',
    run_id: 'run_bash_b',
    status: 'failed',
  };
  assert.equal(bash.terminal(earlyBackground), undefined);
  const handoff = bash.handedOff('call_b', { backgroundTaskId: 'bash_b' });
  assert.equal(handoff && handoff.terminal?.receipt.status, 'failed');
});

test(
  'native Bash stays controllable and reports the real result across same-directory sessions',
  {
    skip: process.platform !== 'linux',
    timeout: 45_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atelier-bash-control-'));
    const project = join(directory, 'project');
    await mkdir(project);
    const oldToken = process.env.ATELIER_GATEWAY_TOKEN;
    process.env.ATELIER_GATEWAY_TOKEN = 'native-bash-fixture';
    const model = 'fixture-bash-control';
    const hold = 'HOLD_BASH_FIXTURE';
    const stop = 'STOP_BASH_FIXTURE';
    const timeout = 'TIMEOUT_BASH_FIXTURE';
    const steer = 'CONTINUE_WITH_NEW_INSTRUCTIONS';
    const ordinary = 'ORDINARY_QUEUED_INSTRUCTIONS';
    const queuedBeforeTimeout = 'MESSAGE_WAITING_AT_BASH_TIMEOUT';
    const commands = {
      [hold]: {
        command:
          "printf 'actual-start\n'; while ! test -f release; do sleep 0.05; done; printf 'actual-end\n'",
        timeout: 30_000,
      },
      [stop]: {
        command: "printf 'stop-start\n'; while ! test -f stop-release; do sleep 0.05; done",
        timeout: 30_000,
      },
      [timeout]: {
        command:
          "printf 'timeout-start\n'; while ! test -f release-timeout; do sleep 0.05; done; printf 'actual-error\n' >&2; exit 7",
        timeout: 1200,
      },
    };
    const issued = new Set<string>();
    const seen = new Set<string>();
    let timeoutCheckpointObserved = false;
    let releaseTimeoutReply = () => {};
    const timeoutReply = new Promise<void>((resolve) => {
      releaseTimeoutReply = resolve;
    });
    const gateway = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ model, id: model }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const wire = Buffer.concat(chunks).toString('utf8');
      for (const text of [steer, ordinary, queuedBeforeTimeout])
        if (wire.includes(text)) seen.add(text);
      const key = ([hold, stop, timeout] as const).find((text) => wire.includes(text));
      if (key && !issued.has(key)) {
        issued.add(key);
        sendModelReply(response, model, [
          {
            id: 'toolu_' + key,
            name: 'Bash',
            input: { ...commands[key], description: 'Run the isolated Bash fixture' },
          },
        ]);
      } else {
        if (
          key === timeout &&
          !timeoutCheckpointObserved &&
          /"tool_use_id"\s*:\s*"toolu_TIMEOUT_BASH_FIXTURE"/u.test(wire)
        ) {
          timeoutCheckpointObserved = true;
          await timeoutReply;
        }
        sendModelReply(response, model, 'Fixture model reply');
      }
    });
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    try {
      gateway.listen(0, '127.0.0.1');
      await once(gateway, 'listening');
      const address = gateway.address();
      assert.ok(address && typeof address === 'object');
      const pairing = 'isolated-bash-fixture';
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
      async function request<T>(
        path: string,
        method = 'GET',
        payload?: unknown,
        status = 200,
      ): Promise<T> {
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
        model,
        managedGateway: false,
      });
      const { project: bound } = await request<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: project },
        201,
      );
      const newSession = async () =>
        (
          await request<{ session: { id: string } }>(
            '/api/sessions',
            'POST',
            { projectId: bound.id },
            201,
          )
        ).session.id;
      const send = (session: string, text: string) =>
        request<SendSessionMessageResult>(
          '/api/sessions/' + session + '/messages',
          'POST',
          {
            text,
            executionPreference: 'native-v1',
            mode: 'edit',
            idempotencyKey: randomUUID(),
          },
          202,
        );
      async function start(session: string, text: string) {
        const result = await send(session, text);
        assert.ok(result.run);
        assert.equal(result.run.executor, 'native-v1');
        return result.run.id;
      }
      const trace = (run: string) => request<{ run: Run; tools: ToolCall[] }>('/api/runs/' + run);
      const wait = async <T>(read: () => Promise<T | undefined>, label: string): Promise<T> => {
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
          const value = await read();
          if (value !== undefined) return value;
          await delay(40);
        }
        throw new Error('Timed out observing ' + label);
      };
      const tool = (run: string, check: (value: ToolCall) => boolean) =>
        wait(
          async () =>
            (await trace(run)).tools.find((value) => value.name === 'Bash' && check(value)),
          'Bash receipt for ' + run,
        );
      const control = (run: string, id: string, action: 'stop' | 'background', status = 200) =>
        request(
          '/api/runs/' + run + '/tools/' + encodeURIComponent(id) + '/bash',
          'POST',
          { action },
          status,
        );
      const sessionA = await newSession();
      const sessionB = await newSession();
      const runA = await start(sessionA, hold);
      const runB = await start(sessionB, stop);
      const [bashA, bashB] = await Promise.all([
        tool(runA, (value) => value.bashExecution?.controllable === true),
        tool(runB, (value) => value.bashExecution?.controllable === true),
      ]);
      await control(runB, bashA.id, 'stop', 404);
      const next = await send(sessionA, steer);
      assert.ok(next.queuedMessage);
      assert.equal(seen.has(steer), false);
      await request(
        '/api/sessions/' + sessionA + '/message-queue/' + next.queuedMessage.id + '/insert',
        'POST',
        { runId: runA, mode: 'live' },
      );
      await wait(
        async () => (seen.has(steer) ? true : undefined),
        'follow-up while Bash is still running',
      );
      assert.equal((await trace(runA)).run.status, 'running');
      assert.equal(
        (await tool(runA, (value) => value.bashExecution?.phase === 'background')).status,
        'running',
      );
      await control(runB, bashB.id, 'stop');
      const stopped = await tool(runB, (value) => value.endedAt !== null);
      assert.equal(stopped.status, 'canceled');
      assert.equal(stopped.bashExecution?.phase, 'stopped');
      await wait(
        async () => ((await trace(runB)).run.status === 'completed' ? true : undefined),
        'stopped command follow-up',
      );
      assert.equal((await trace(runA)).run.status, 'running');
      await send(sessionA, ordinary);
      await wait(
        async () => (seen.has(ordinary) ? true : undefined),
        'ordinary follow-up with background Bash',
      );
      await writeFile(join(project, 'release'), '');
      const ended = await tool(runA, (value) => value.endedAt !== null);
      assert.equal(ended.status, 'succeeded');
      assert.equal(ended.bashLog?.status, 'complete');
      const output = await fetch(
        base + '/api/tools/' + encodeURIComponent(ended.id) + '/output?view=display&download=1',
        { headers },
      );
      assert.equal(output.status, 200);
      assert.match(await output.text(), /actual-start[\s\S]*actual-end/);
      await wait(
        async () => ((await trace(runA)).run.status === 'completed' ? true : undefined),
        'run cleanup',
      );
      assert.equal(
        (await request<{ messageQueue: SessionMessageQueue }>('/api/sessions/' + sessionA))
          .messageQueue.items.length,
        0,
      );
      const snapshot = await request<{ messages: Message[]; runs: Run[] }>(
        '/api/sessions/' + sessionA,
      );
      const recorded = snapshot.runs.find(({ id }) => id === runA);
      assert.equal(recorded?.transcript?.version, 1);
      const initial = snapshot.messages.find(({ text }) => text === hold);
      const inserted = snapshot.messages.find(({ text }) => text === steer);
      assert.ok(initial?.transcriptOrder && ended.transcriptOrder && inserted?.transcriptOrder);
      assert.ok(initial.transcriptOrder < ended.transcriptOrder);
      assert.ok(ended.transcriptOrder < inserted.transcriptOrder);
      const replies = snapshot.messages.filter(
        ({ runId, role, text }) => runId === runA && role === 'assistant' && text.trim(),
      );
      assert.ok(replies.length > 0);
      for (const reply of replies) {
        assert.ok(reply.transcriptParts?.length);
        assert.equal(
          reply.transcriptParts.map(({ start, end }) => reply.text.slice(start, end)).join('\n\n'),
          reply.text,
        );
      }

      const sessionC = await newSession();
      const runC = await start(sessionC, timeout);
      await tool(runC, (value) => value.status === 'running');
      assert.ok((await send(sessionC, queuedBeforeTimeout)).queuedMessage);
      await wait(async () => {
        if (!timeoutCheckpointObserved) return undefined;
        const { messageQueue } = await request<{ messageQueue: SessionMessageQueue }>(
          '/api/sessions/' + sessionC,
        );
        return messageQueue.items.some(
          (item) => item.text === queuedBeforeTimeout && item.delivery === 'sending',
        )
          ? true
          : undefined;
      }, 'prompt dispatch at the timeout checkpoint before the model responds');
      releaseTimeoutReply();
      await wait(
        async () => (seen.has(queuedBeforeTimeout) ? true : undefined),
        'queued prompt during timeout handoff',
      );
      await writeFile(join(project, 'release-timeout'), '');
      const failure = await tool(runC, (value) => value.endedAt !== null);
      assert.equal(failure.status, 'failed');
      assert.equal(failure.bashExecution?.foregroundTimeoutMs, 1200, JSON.stringify(failure));
      assert.match(failure.output, /exit code 7/i);
      const failedLog = await fetch(
        base + '/api/tools/' + encodeURIComponent(failure.id) + '/output?view=display&download=1',
        { headers },
      );
      assert.match(await failedLog.text(), /actual-error/);
    } finally {
      releaseTimeoutReply();
      await app?.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      if (oldToken === undefined) delete process.env.ATELIER_GATEWAY_TOKEN;
      else process.env.ATELIER_GATEWAY_TOKEN = oldToken;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
