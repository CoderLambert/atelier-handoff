/**
 * @file 验证本机 Skill 继承通过 API 传递至运行时 SDK。
 * @implementation 使用临时目录、配对 API 和回环模型替身，检查不同运行与会话的 Skill 策略，以及排队消息授权变化后的复核恢复。
 * @updated 2026-11-27T02:25:28+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import { skillInheritanceViewSchema } from '../shared/skill-inheritance.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function install(root: string, name: string, description: string, text: string) {
  const directory = join(root, '.claude', 'skills', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${text}\n`,
  );
  return directory;
}

const ident = z.object({ id: z.string() });
const native = { mode: 'edit', executionPreference: 'native-v1', model: 'fixture-inheritance' };
const responseSchema = z.object({ run: ident });
const captureSchema = z.object({
  runs: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      reason: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  messageQueue: z
    .object({
      items: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          error: z.string().nullable(),
          insertion: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

function checkpoint() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test(
  'paired API and locked SDK apply local Skill changes between runs without restarting',
  { skip: process.platform !== 'linux', timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'atelier-inheritance-sdk-'));
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, 'home');
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const capture: string[] = [];
    const childCapture: string[] = [];
    let branchSent = false;
    const held = checkpoint();
    const entered = checkpoint();
    const gateway = createServer(async (req, res) => {
      if (req.url === '/health') {
        res.end('{}');
        return;
      }
      if (!req.url?.startsWith('/v1/messages')) {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      capture.push(body);
      if (body.includes('hold-next-run')) {
        entered.resolve();
        await held.promise;
      }
      const stage = capture.length;
      const modelRequest = z
        .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
        .safeParse(JSON.parse(body));
      const firstUser = modelRequest.success
        ? modelRequest.data.messages.find(({ role }) => role === 'user')
        : undefined;
      if (JSON.stringify(firstUser)?.includes('LOCAL_CHILD_SKILL_CHECK')) {
        childCapture.push(body);
        sendModelReply(res, native.model, 'child fixture complete');
      } else if (!branchSent && body.includes('spawn-local-scope-branch')) {
        branchSent = true;
        sendModelReply(res, native.model, [
          {
            name: 'Agent',
            id: 'toolu_inherit_child',
            input: {
              description: 'Check child scope',
              prompt: 'LOCAL_CHILD_SKILL_CHECK',
              subagent_type: 'atelier-explore',
              run_in_background: false,
            },
          },
        ]);
      } else if (stage === 2 || stage === 4 || stage === 5) {
        sendModelReply(res, native.model, [
          {
            name: 'Skill',
            id: `toolu_inherit_${stage}`,
            input: { skill: 'host-skills:fixture-notes' },
          },
        ]);
      } else {
        sendModelReply(res, native.model, 'fixture complete');
      }
    });
    t.after(async () => {
      try {
        held.resolve();
        await app?.close();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        await rm(root, { recursive: true, force: true });
      }
    });
    const project = join(root, 'project');
    const host = await install(
      join(root, 'shared'),
      'fixture-notes',
      'HOST_INHERITANCE_DESCRIPTION',
      'HOST_INHERITANCE_BODY',
    );
    await mkdir(join(process.env.HOME, '.claude', 'skills'), { recursive: true });
    await symlink(host, join(process.env.HOME, '.claude', 'skills', 'fixture-notes'));
    await install(
      project,
      'fixture-notes',
      'WORKSPACE_INHERITANCE_DESCRIPTION',
      'WORKSPACE_INHERITANCE_BODY',
    );
    const gatewayUrl = await listen(gateway);
    const pairing = 'local-fixture-pairing';
    app = await createApp({
      root: fileURLToPath(new URL('../', import.meta.url)),
      data: join(root, 'data'),
      nativeExecution: true,
      desktopPairing: pairing,
    });
    app.store.setConfig({ ...app.store.config(), gateway: gatewayUrl, managedGateway: false });
    const origin = await listen(app.server);
    const headers: Record<string, string> = {
      [desktopPairingHeader]: pairing,
      'content-type': 'application/json',
    };
    const boot = z
      .object({ csrfToken: z.string() })
      .parse(await fetch(`${origin}/api/bootstrap`, { headers }).then((res) => res.json()));
    headers['x-atelier-token'] = boot.csrfToken;
    async function api(
      path: string,
      method = 'GET',
      data?: unknown,
      status = 200,
    ): Promise<unknown> {
      const response = await fetch(origin + '/api/' + path, {
        method,
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const json: unknown = await response.json();
      assert.equal(response.status, status, JSON.stringify(json));
      return json;
    }
    const scope = 'skill-inheritance';
    async function read(path = scope) {
      return skillInheritanceViewSchema.parse(await api(path));
    }
    async function patch(data: unknown, path = scope) {
      return skillInheritanceViewSchema.parse(await api(path, 'PATCH', data));
    }
    const initial = await read();
    assert.equal(initial.enabled, false);
    const skill = initial.items.find(({ name }) => name === 'fixture-notes');
    assert.ok(skill);
    assert.equal(skill.mode, 'off');
    const { project: bound } = z
      .object({ project: ident })
      .parse(await api('projects', 'POST', { path: project }, 201));
    const createSession = async () =>
      z
        .object({ session: ident })
        .parse(await api('sessions', 'POST', { projectId: bound.id }, 201)).session;
    const a = await createSession();
    const b = await createSession();
    const pathA = `${scope}?sessionId=${a.id}&native=1`;
    const pathB = `${scope}?sessionId=${b.id}&native=1`;
    const aView = await read(pathA);
    assert.equal(aView.items.filter(({ name }) => name === 'fixture-notes').length, 2);
    assert.notEqual(aView.items.find(({ source }) => source === 'workspace')?.id, skill.id);
    async function run(
      sessionId: string,
      text: string,
      extensionSelections?: { id: string; version: number }[],
    ) {
      const {
        run: { id },
      } = responseSchema.parse(
        await api(
          `sessions/${sessionId}/messages`,
          'POST',
          { ...native, text, extensionSelections, idempotencyKey: randomUUID() },
          202,
        ),
      );
      for (let retry = 0; retry < 120; retry++) {
        const current = captureSchema
          .parse(await api(`sessions/${sessionId}`))
          .runs.find((entry) => entry.id === id);
        if (current && ['completed', 'failed', 'stopped'].includes(current.status)) {
          assert.equal(current.status, 'completed', JSON.stringify(current));
          return id;
        }
        await delay(25);
      }
      assert.fail(`run ${id} did not finish`);
    }
    await run(a.id, 'default off');
    assert.ok(capture[0]?.includes('WORKSPACE_INHERITANCE_DESCRIPTION'));
    assert.ok(!capture[0]?.includes('HOST_INHERITANCE_DESCRIPTION'));
    assert.equal((await patch({ type: 'global', enabled: true })).items[0]?.effective, 'off');
    await patch({ type: 'host', id: skill.id, mode: 'auto' });
    const invoked = await run(a.id, 'auto enabled');
    assert.ok(capture[1]?.includes('HOST_INHERITANCE_DESCRIPTION'));
    assert.ok(capture[2]?.includes('HOST_INHERITANCE_BODY'));
    assert.ok(
      app.store
        .since(0)
        .some(
          (event) =>
            event.runId === invoked &&
            event.type === 'skill.invoked' &&
            event.payload.source === 'host',
        ),
    );
    await patch({ type: 'session', id: skill.id, mode: 'off' }, pathA);
    assert.equal((await read(pathB)).items.find(({ id }) => id === skill.id)?.effective, 'auto');
    await patch({ type: 'global', enabled: false });
    await run(b.id, 'global off in existing session');
    assert.ok(!capture[3]?.includes('HOST_INHERITANCE_DESCRIPTION'));
    assert.ok(!capture[4]?.includes('HOST_INHERITANCE_BODY'));
    assert.ok(!capture[5]?.includes('HOST_INHERITANCE_BODY'));
    const blockedSelection = {
      ...native,
      text: 'stale selection',
      extensionSelections: [{ id: skill.id, version: skill.version }],
      idempotencyKey: randomUUID(),
    };
    await api(`sessions/${b.id}/messages`, 'POST', blockedSelection, 409);
    await patch({ type: 'global', enabled: true });
    assert.equal((await read(pathA)).items.find(({ id }) => id === skill.id)?.effective, 'off');
    await patch({ type: 'host', id: skill.id, mode: 'manual' });
    assert.equal((await read(pathB)).items.find(({ id }) => id === skill.id)?.effective, 'manual');
    const beforeManual = capture.length;
    await run(b.id, 'manual selected', [{ id: skill.id, version: skill.version }]);
    assert.ok(capture[beforeManual]?.includes('HOST_INHERITANCE_BODY'));
    assert.ok(!capture[beforeManual]?.includes('HOST_INHERITANCE_DESCRIPTION'));
    const projectScope = `${scope}?projectId=${bound.id}`;
    await patch({ type: 'project', mode: 'block' }, projectScope);
    assert.equal(
      (await read(pathB)).items.find(({ id }) => id === skill.id)?.reason,
      'project-blocked',
    );
    await patch({ type: 'project', mode: 'follow' }, projectScope);
    await patch({ type: 'host', id: skill.id, mode: 'auto' });
    await api(
      `sessions/${b.id}/messages`,
      'POST',
      { ...native, text: 'hold-next-run', idempotencyKey: randomUUID() },
      202,
    );
    await entered.promise;
    const queuedText = 'keep this queued message';
    const { queuedMessage } = z
      .object({ queuedMessage: ident })
      .parse(
        await api(
          `sessions/${b.id}/messages`,
          'POST',
          { ...native, text: queuedText, idempotencyKey: randomUUID() },
          202,
        ),
      );
    await patch({ type: 'global', enabled: false });
    const pending = () =>
      api(`sessions/${b.id}`).then((data) =>
        captureSchema.parse(data).messageQueue?.items.find(({ id }) => id === queuedMessage.id),
      );
    assert.equal((await pending())?.insertion, 'priority');
    held.resolve();
    let blocked: Awaited<ReturnType<typeof pending>> = undefined;
    for (let retry = 0; retry < 160; retry++) {
      blocked = await pending();
      if (blocked?.error) break;
      await delay(25);
    }
    assert.equal(blocked?.text, queuedText);
    assert.match(blocked?.error ?? '', /复核/u);
    assert.ok(capture.every((body) => !body.includes(queuedText)));
    await api(`sessions/${b.id}/message-queue/resume`, 'POST', { reviewItemId: queuedMessage.id });
    for (let retry = 0; retry < 160 && !capture.some((body) => body.includes(queuedText)); retry++) {
      await delay(25);
    }
    const resumed = capture.find((body) => body.includes(queuedText));
    assert.ok(resumed, 'The SDK should receive the reviewed message');
    const { tools } = z.object({ tools: z.unknown() }).parse(JSON.parse(resumed));
    assert.ok(!JSON.stringify(tools).includes('HOST_INHERITANCE_DESCRIPTION'));
    const fresh = await createSession();
    await run(fresh.id, 'spawn-local-scope-branch');
    assert.equal(childCapture.length, 1, 'SDK executed a real child query');
    assert.ok(
      childCapture.every(
        (body) =>
          !body.includes('HOST_INHERITANCE_DESCRIPTION') && !body.includes('HOST_INHERITANCE_BODY'),
      ),
    );
  },
);
