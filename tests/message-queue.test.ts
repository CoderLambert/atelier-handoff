/**
 * @file 验证会话队列、实时投递状态和重启恢复。
 * @implementation 用隔离 SQLite、真实 HTTP 和可控运行器检查消息顺序、幂等、撤回、草稿与附件保留，以及投递中断后继续发送。
 * @updated 2026-11-21T00:28:46+08:00
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { MessageQueue } from '../server/message-queue.js';
import {
  emptyDraft,
  now,
  type Run,
  type Session,
  type SessionMessageQueue,
  type SendSessionMessageResult,
} from '../shared/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));

async function waitFor(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < end, 'Expected the next queued turn to start');
    await delay(10);
  }
}

test('queued turns persist, run FIFO after cleanup and resume after reopening', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'atelier-queue-'));
  const project = join(temp, 'project');
  const file = join(project, 'note.txt');
  const starts: { run: Run; input: string }[] = [];
  const complete = new Map<string, (status?: Run['status']) => void>();
  const startApp = async () => {
    const app = await createApp({
      root,
      data: join(temp, 'data'),
      runnerFactory: (store) => ({
        start(run, input) {
          starts.push({ run, input });
          store.update('runs', run.id, { status: 'running', startedAt: now() });
          return new Promise<void>((resolve) => {
            complete.set(run.id, (status = 'completed') => {
              complete.delete(run.id);
              store.update('runs', run.id, { status, endedAt: now() });
              store.event(run.id, run.sessionId, 'run.finished', { status });
              resolve();
            });
          });
        },
        stop(id) {
          store.update('runs', id, { status: 'stopping' });
        },
        async shutdown() {
          for (const finish of complete.values()) finish('interrupted');
        },
      }),
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const { csrfToken } = (await (await fetch(url + '/api/bootstrap')).json()) as {
      csrfToken: string;
    };
    async function request<T>(
      path: string,
      method = 'GET',
      body?: unknown,
      status = 200,
    ): Promise<T> {
      const response = await fetch(url + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result: unknown = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result as T;
    }
    return { app, request };
  };
  let running: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    await mkdir(project);
    await writeFile(file, 'before the first turn');
    running = await startApp();
    const p = await running.request<{ project: { id: string } }>(
      '/api/projects',
      'POST',
      { path: project },
      201,
    );
    const newSession = () =>
      running!.request<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: p.project.id },
        201,
      );
    const { session } = await newSession();
    const other = (await newSession()).session;
    const path = `/api/sessions/${session.id}`;
    const send = (text: string) => ({ text, idempotencyKey: randomUUID() });
    const sendBody = (data: Record<string, unknown>) =>
      running!.request<SendSessionMessageResult>(path + '/messages', 'POST', data, 202);
    const state = () =>
      running!.request<{
        messageQueue: SessionMessageQueue;
        session: Session;
        messages: { text: string }[];
        runs: Run[];
      }>(path);
    const a = (await sendBody(send('A'))).run;
    assert.ok(a);
    const attachment = await running.request<{ attachment: { id: string } }>(
      path + '/attachments',
      'POST',
      {
        name: 'data.txt',
        contentBase64: Buffer.from('queued attachment').toString('base64'),
      },
      201,
    );
    const b = {
      ...send('B'),
      model: 'test-fixed-model',
      effort: 'high',
      mode: 'edit',
      approvalMode: 'automatic',
      maxSearchChargeFen: 42,
      contextPaths: ['note.txt'],
      attachmentIds: [attachment.attachment.id],
    };
    const queued = (await sendBody(b)).queuedMessage;
    assert.ok(queued);
    assert.equal((await sendBody(b)).queuedMessage?.id, queued.id);
    await running.request(path + '/messages', 'POST', { ...b, text: 'changed' }, 409);
    const c = send('C');
    await sendBody(c);
    const removed = (await sendBody(send('撤回测试'))).queuedMessage;
    assert.ok(removed);
    assert.deepEqual(
      (await state()).messageQueue.items.map((item) => item.text),
      ['B', 'C', '撤回测试'],
    );
    assert.deepEqual(
      (await state()).messages.map((message) => message.text),
      ['A'],
    );
    assert.deepEqual(
      (await running.request<{ messageQueue: SessionMessageQueue }>(`/api/sessions/${other.id}`))
        .messageQueue.items,
      [],
    );
    await running.request(
      `/api/sessions/${other.id}/message-queue/${queued.id}`,
      'DELETE',
      undefined,
      409,
    );
    await running.request(
      path + `/attachments/${attachment.attachment.id}`,
      'DELETE',
      undefined,
      409,
    );
    await running.request(path + `/message-queue/${removed.id}`, 'DELETE');
    assert.equal(starts.length, 1);
    await running.request(path, 'PATCH', { draft: { ...emptyDraft(), text: 'keep editing' } });
    await running.request(`/api/runs/${a.id}/stop`, 'POST', {});
    assert.equal(starts.length, 1);
    await writeFile(file, 'effect of the first turn');
    complete.get(a.id)?.('stopped');
    await waitFor(() => starts.length === 2);
    const second = starts[1];
    assert.ok(second);
    assert.equal(second.run.prompt, 'B');
    assert.equal(second.run.config.model, 'test-fixed-model');
    assert.equal(second.run.config.effort, 'high');
    assert.equal(second.run.approvalMode, 'automatic');
    assert.equal(second.run.maxSearchChargeFen, 42);
    assert.match(second.input, /effect of the first turn/u);
    assert.match(second.input, /queued attachment/u);
    assert.equal((await sendBody(b)).run?.id, second.run.id);
    assert.equal((await state()).session.draft.text, 'keep editing');
    assert.deepEqual(
      (await state()).messageQueue.items.map((item) => item.text),
      ['C'],
    );

    await running.app.close();
    running = await startApp();
    const reopened = (await state()).messageQueue;
    assert.equal(reopened.paused, true);
    assert.deepEqual(
      reopened.items.map((item) => item.text),
      ['C'],
    );
    assert.equal(
      (await state()).runs.find((run) => run.id === second.run.id)?.status,
      'interrupted',
    );
    assert.equal(starts.length, 2);
    assert.equal((await sendBody(c)).queuedMessage?.text, 'C');
    await running.request(path + '/message-queue/resume', 'POST', {});
    await waitFor(() => starts.length === 3);
    assert.deepEqual(
      starts.map(({ run }) => run.prompt),
      ['A', 'B', 'C'],
    );
    assert.deepEqual((await state()).messageQueue.items, []);
    assert.equal((await state()).session.draft.text, 'keep editing');
    const activeId = starts[2]?.run.id;
    assert.ok(activeId);
    const queuedWhileRunning = (await sendBody(send('interrupted insertion'))).queuedMessage;
    assert.ok(queuedWhileRunning);
    const queueStore = new MessageQueue(running.app.store);
    queueStore.resume(session.id);
    const item = queueStore.pending(session.id, queuedWhileRunning.id);
    assert.ok(item);
    queueStore.beginLive(item, activeId);
    queueStore.dispatched(item, activeId);
    const toolId = activeId + ':toolu_restart_fixture';
    running.app.store.put('tools', {
      id: toolId,
      runId: activeId,
      sessionId: session.id,
      name: 'Bash',
      inputSummary: '{}',
      status: 'running',
      output: '',
      startedAt: now(),
      endedAt: null,
      bashExecution: { phase: 'background', controllable: true, lastObservedAt: now() },
    });
    await running.app.close();
    running = await startApp();
    const uncertain = (await state()).messageQueue;
    assert.equal(uncertain.paused, false);
    assert.equal(uncertain.items[0]?.delivery, 'unknown');
    const recoveredBash = running.app.store.get('tools', toolId);
    assert.equal(recoveredBash.bashExecution?.phase, 'unknown');
    assert.equal(recoveredBash.bashExecution?.controllable, false);
    await sendBody(send('new message after uncertain delivery'));
    await waitFor(() => starts.length === 4);
    assert.equal(starts[3]?.run.prompt, 'new message after uncertain delivery');
    assert.deepEqual(
      (await state()).messageQueue.items.map((row) => row.delivery),
      ['unknown'],
    );
    complete.get(starts[3]?.run.id ?? '')?.();
  } finally {
    await running?.app.close();
    await rm(temp, { recursive: true, force: true });
  }
});
