/**
 * @file 验证从消息分支的 HTTP、持久化和原生 SDK 续接行为。
 * @implementation 使用隔离数据根和回环模型替身捕获三个会话各自发送的上下文。
 * @updated 2026-11-21T00:00:00Z
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { SessionForks } from '../server/session-forks.js';
import type { Draft, InheritedMessage, Message, Run, Session } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

interface Snapshot {
  session: Session;
  messages: Message[];
  inheritedMessages?: InheritedMessage[];
  runs: Run[];
}

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
};

test(
  'message forks preserve the cutoff and can resume independently after source deletion',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atelier-session-branches-'));
    const projectPath = join(directory, 'project');
    const data = join(directory, 'data');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const model = 'branch-fixture';
    const requests: string[] = [];
    const gateway = createServer(async (request, response) => {
      const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (pathname === '/health') return response.writeHead(200).end();
      if (pathname !== '/v1/messages') return response.writeHead(404).end();
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { messages } = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(JSON.stringify(messages));
        sendModelReply(response, model, `fixture answer ${requests.length}`);
      } catch {
        response.writeHead(400).end();
      }
    });
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    let base: string;
    let token = '';
    async function http<T>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      const result: unknown = await response.json();
      assert.equal(response.status, status, JSON.stringify(result));
      return result as T;
    }
    const snapshot = (id: string) => http<Snapshot>(`/api/sessions/${id}`);
    const bootstrap = () => http<{ csrfToken: string; sessions: Session[] }>('/api/bootstrap');
    async function turn(
      id: string,
      text: string,
      options: Pick<Draft, 'effort' | 'extensionSelections'> = {},
    ) {
      const { run } = await http<{ run: Run }>(
        `/api/sessions/${id}/messages`,
        'POST',
        {
          text,
          ...options,
          idempotencyKey: randomUUID(),
        },
        202,
      );
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        const detail = await http<{ run: Run }>(`/api/runs/${run.id}`);
        if (['failed', 'interrupted', 'stopped'].includes(detail.run.status))
          assert.fail(detail.run.error ?? detail.run.status);
        if (detail.run.status === 'completed') return snapshot(id);
        await delay(25);
      }
      assert.fail('loopback run did not finish');
    }
    try {
      await mkdir(projectPath);
      const gatewayUrl = await listen(gateway);
      app = await createApp({ root, data });
      app.store.setConfig({
        ...app.store.config(),
        gateway: gatewayUrl,
        managedGateway: false,
        model,
      });
      base = await listen(app.server);
      token = (await bootstrap()).csrfToken;
      const { project } = await http<{ project: { id: string } }>(
        '/api/projects',
        'POST',
        { path: projectPath },
        201,
      );
      const { session: parent } = await http<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: project.id },
        201,
      );
      const first = await turn(parent.id, 'SHARED_BRANCH_SENTINEL');
      const origin = first.messages.find((message) => message.role === 'assistant');
      const userOrigin = first.messages.find((message) => message.role === 'user');
      assert.ok(origin?.forkAnchor && userOrigin?.forkAnchor);
      const later = await turn(parent.id, 'PARENT_ONLY_SENTINEL');
      assert.equal(later.messages.length, 4);

      const count = requests.length;
      // Older records had neither of the application-side anchor fields.
      app.store.update('messages', origin.id, { forkAnchor: undefined });
      app.store.update('messages', userOrigin.id, { forkAnchor: undefined });
      const legacy = await snapshot(parent.id);
      assert.deepEqual(
        legacy.messages.find(({ id }) => id === origin.id)?.forkAnchor,
        origin.forkAnchor,
      );
      assert.deepEqual(
        legacy.messages.find(({ id }) => id === userOrigin.id)?.forkAnchor,
        userOrigin.forkAnchor,
      );
      assert.equal(requests.length, count);
      const input = { messageId: origin.id, idempotencyKey: randomUUID() };
      const create = (messageId: string, idempotencyKey = randomUUID()) =>
        http<{ session: Session }>(
          `/api/sessions/${parent.id}/fork`,
          'POST',
          { messageId, idempotencyKey },
          201,
        );
      const [{ session: a }, duplicate, { session: b }, { session: userBranch }] =
        await Promise.all([
          create(input.messageId, input.idempotencyKey),
          create(input.messageId, input.idempotencyKey),
          create(input.messageId),
          create(userOrigin.id),
        ]);
      assert.equal(requests.length, count, 'forking should make no model request');
      assert.equal(a.id, duplicate.session.id);
      assert.equal(
        new Set([parent.sdkSessionId, a.sdkSessionId, b.sdkSessionId, userBranch.sdkSessionId])
          .size,
        4,
      );
      assert.deepEqual(
        (await snapshot(a.id)).inheritedMessages?.map(({ text }) => text),
        ['SHARED_BRANCH_SENTINEL', 'fixture answer 1'],
      );
      assert.deepEqual(
        (await snapshot(userBranch.id)).inheritedMessages?.map(({ text }) => text),
        ['SHARED_BRANCH_SENTINEL'],
      );
      assert.deepEqual((await snapshot(b.id)).messages, []);
      const denied = await http<{ error: string }>(
        `/api/sessions/${a.id}/fork`,
        'POST',
        {
          messageId: origin.id,
          idempotencyKey: randomUUID(),
        },
        409,
      );
      assert.ok(denied.error);
      assert.equal(
        (await bootstrap()).sessions.find((item) => item.id === a.id)?.inheritedMessages,
        undefined,
      );
      const unfinishedId = randomUUID();
      const unfinishedDirectory = join(data, 'sdk', unfinishedId);
      await mkdir(unfinishedDirectory);
      app.store.put('sessions', { ...a, id: unfinishedId, creatingFork: true, sdkSessionId: null });
      assert.ok(!(await bootstrap()).sessions.some(({ id }) => id === unfinishedId));
      await http(`/api/sessions/${parent.id}`, 'DELETE');
      await app.close();
      app = await createApp({ root, data });
      base = await listen(app.server);
      token = (await bootstrap()).csrfToken;
      assert.ok(!app.store.list('sessions').some(({ id }) => id === unfinishedId));
      const aSnapshot = await turn(a.id, 'A_ONLY_SENTINEL');
      const bSnapshot = await turn(b.id, 'B_ONLY_SENTINEL');
      await turn(a.id, 'A_FOLLOWUP_SENTINEL');
      assert.equal(aSnapshot.session.sdkSessionId, a.sdkSessionId);
      assert.equal(bSnapshot.session.sdkSessionId, b.sdkSessionId);
      assert.match(requests[count] ?? '', /SHARED_BRANCH_SENTINEL/);
      assert.match(requests[count] ?? '', /fixture answer 1/);
      assert.doesNotMatch(requests[count] ?? '', /PARENT_ONLY_SENTINEL/);
      assert.doesNotMatch(requests[count + 1] ?? '', /A_ONLY_SENTINEL|PARENT_ONLY_SENTINEL/);
      assert.match(requests[count + 2] ?? '', /A_ONLY_SENTINEL/);
      assert.doesNotMatch(requests[count + 2] ?? '', /B_ONLY_SENTINEL|PARENT_ONLY_SENTINEL/);
      const rebuilt = await turn(a.id, 'A_NEW_EFFORT_SENTINEL', { effort: 'high' });
      assert.notEqual(rebuilt.session.sdkSessionId, a.sdkSessionId);
      const rebuiltRequest = requests[count + 3] ?? '';
      assert.match(rebuiltRequest, /SHARED_BRANCH_SENTINEL/);
      assert.match(rebuiltRequest, /A_ONLY_SENTINEL/);
      assert.doesNotMatch(rebuiltRequest, /B_ONLY_SENTINEL|PARENT_ONLY_SENTINEL/);

      const beforeRewind = await snapshot(a.id);
      const target = beforeRewind.messages.find((message) => message.text === 'A_ONLY_SENTINEL');
      const head = beforeRewind.messages.at(-1);
      const latestRun = beforeRewind.runs.at(-1);
      assert.ok(target?.forkAnchor && head && latestRun);
      const prefs = { ...beforeRewind.session.draft, text: 'KEEP_EXISTING_DRAFT' };
      await http(`/api/sessions/${a.id}`, 'PATCH', { draft: prefs });
      const projectFile = join(projectPath, 'version.txt');
      await writeFile(projectFile, 'Contents changed after the selected message');
      const inputRewind = {
        messageId: target.id,
        idempotencyKey: randomUUID(),
        rewindFromHead: head.id,
      };
      const rewindRoute = `/api/sessions/${a.id}/fork`;
      const beforeRewindRequests = requests.length;
      const lateRequest = { ...inputRewind, idempotencyKey: randomUUID() };
      const lateMessageId = randomUUID();
      const testStore = app.store;
      const racingFork = new SessionForks(testStore, async () => {
        testStore.put('messages', { ...head, id: lateMessageId, text: 'LATE_SOURCE_MESSAGE' });
        return randomUUID();
      });
      try {
        await assert.rejects(racingFork.create(a.id, lateRequest), { code: 'REWIND_CHANGED' });
        assert.ok(!testStore.list('sessions').some(({ id }) => id === lateRequest.idempotencyKey));
      } finally {
        testStore.delete('messages', lateMessageId);
      }
      const { error: stale } = await http<{ error: { code: string } }>(
        rewindRoute,
        'POST',
        {
          ...inputRewind,
          rewindFromHead: randomUUID(),
        },
        409,
      );
      assert.equal(stale.code, 'REWIND_CHANGED');
      await http(`/api/sessions/${a.id}`, 'PATCH', { status: 'archived' });
      const { error: archived } = await http<{ error: { code: string } }>(
        rewindRoute,
        'POST',
        inputRewind,
        409,
      );
      assert.equal(archived.code, 'SESSION_ARCHIVED');
      await http(`/api/sessions/${a.id}`, 'PATCH', { status: 'active' });
      app.store.update('runs', latestRun.id, { status: 'running' });
      try {
        const { error: busy } = await http<{ error: { code: string } }>(
          rewindRoute,
          'POST',
          inputRewind,
          409,
        );
        assert.equal(busy.code, 'REWIND_BUSY');
        const { queuedMessage } = await http<{ queuedMessage: { id: string } }>(
          `/api/sessions/${a.id}/messages`,
          'POST',
          {
            text: 'QUEUED_SENTINEL',
            idempotencyKey: randomUUID(),
          },
          202,
        );
        app.store.update('runs', latestRun.id, { status: 'completed' });
        const { error: queued } = await http<{ error: { code: string } }>(
          rewindRoute,
          'POST',
          inputRewind,
          409,
        );
        assert.equal(queued.code, 'REWIND_BUSY');
        app.store.update('runs', latestRun.id, { status: 'running' });
        await http(`/api/sessions/${a.id}/message-queue/${queuedMessage.id}`, 'DELETE');
      } finally {
        app.store.update('runs', latestRun.id, { status: 'completed' });
      }
      const { session: rewound } = await http<{ session: Session }>(
        rewindRoute,
        'POST',
        inputRewind,
        201,
      );
      assert.equal(rewound.fork?.kind, 'rewind');
      assert.equal(rewound.title, beforeRewind.session.title);
      assert.equal(
        (await http<{ session: Session }>(rewindRoute, 'POST', inputRewind, 201)).session.id,
        rewound.id,
      );
      assert.equal(requests.length, beforeRewindRequests);
      assert.equal((await snapshot(a.id)).session.draft.text, prefs.text);
      assert.deepEqual((await snapshot(a.id)).messages, beforeRewind.messages);
      assert.equal((await snapshot(rewound.id)).session.draft.text, '');
      assert.equal(
        await readFile(projectFile, 'utf8'),
        'Contents changed after the selected message',
      );
      const continued = await turn(rewound.id, 'REWOUND_FOLLOWUP_SENTINEL');
      assert.equal(continued.session.sdkSessionId, rewound.sdkSessionId);
      assert.match(requests[beforeRewindRequests] ?? '', /A_ONLY_SENTINEL/);
      assert.doesNotMatch(
        requests[beforeRewindRequests] ?? '',
        /A_FOLLOWUP_SENTINEL|A_NEW_EFFORT_SENTINEL/,
      );

      const { item: skill } = await http<{ item: { id: string; version: number } }>(
        `/api/projects/${project.id}/extensions`,
        'POST',
        {
          kind: 'skill',
          name: 'branch-review',
          body: '---\ndescription: Check a fixture\n---\nUse a checklist.',
          enabled: true,
        },
        201,
      );
      const { session: skillSession } = await http<{ session: Session }>(
        '/api/sessions',
        'POST',
        { projectId: project.id },
        201,
      );
      const skillRequestIndex = requests.length;
      const skillTurn = await turn(skillSession.id, 'SKILL_BRANCH_SENTINEL', {
        extensionSelections: [{ id: skill.id, version: skill.version }],
      });
      assert.match(requests[skillRequestIndex] ?? '', /本轮用户要求/);
      const skillReply = skillTurn.messages.find(({ role }) => role === 'assistant');
      assert.ok(skillReply?.forkAnchor);
      for (const message of skillTurn.messages)
        app.store.update('messages', message.id, { forkAnchor: undefined });
      const recoveredSkill = await snapshot(skillSession.id);
      assert.deepEqual(
        recoveredSkill.messages.map(({ forkAnchor }) => forkAnchor),
        skillTurn.messages.map(({ forkAnchor }) => forkAnchor),
      );
      const beforeSkillFork = requests.length;
      const { session: skillBranch } = await http<{ session: Session }>(
        `/api/sessions/${skillSession.id}/fork`,
        'POST',
        { messageId: skillReply.id, idempotencyKey: randomUUID() },
        201,
      );
      assert.equal(requests.length, beforeSkillFork);
      assert.deepEqual(
        (await snapshot(skillBranch.id)).inheritedMessages?.map(({ text }) => text),
        skillTurn.messages.map(({ text }) => text),
      );
    } finally {
      await app?.close();
      if (gateway.listening) {
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
