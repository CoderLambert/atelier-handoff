/**
 * @file Verifies the task planning guidance through the real Claude Agent SDK.
 * @implementation Sends controlled readonly and native session requests to an isolated runtime and inspects the loopback model calls and saved plans.
 * @updated 2026-11-28T18:50:22+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import { acceptanceReceipt } from '../shared/run-acceptance.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const planName = 'mcp__atelier__update_plan';
const settingsPath = '/api/settings/task-planning';
const todoName = 'TodoWrite';
const model = 'plan-fixture';
const steps = [
  { content: '只读核对登录入口和错误证据', status: 'in_progress' },
  { content: '汇报已确认原因、证据和待确认项', status: 'pending' },
];

for (const native of [false, true]) {
  test(
    `${native ? 'native' : 'controlled readonly'} runs send planning guidance to the SDK and save the tool plan`,
    { timeout: 35_000, skip: native && process.platform !== 'linux' },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'atelier-plan-generation-'));
      const projectPath = join(directory, 'project');
      await mkdir(projectPath);
      const requests: unknown[] = [];
      const replies: (() =>
        Parameters<typeof sendModelReply>[2] | Promise<Parameters<typeof sendModelReply>[2]>)[] =
        [];
      let firstResponse: () => void = () => {};
      const firstResponseReady = new Promise<void>((resolve) => {
        firstResponse = resolve;
      });
      let releaseFirst: () => void = () => {};
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      replies.push(
        async () => {
          firstResponse();
          await firstReleased;
          return [{ name: planName, id: 'toolu_plan', input: { steps } }];
        },
        () => '已记录只读排查清单。',
      );
      const gateway = createServer(async (request, response) => {
        if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) {
          response.end('{}');
          return;
        }
        request.setEncoding('utf8');
        let text = '';
        for await (const chunk of request) text += String(chunk);
        requests.push(JSON.parse(text));
        sendModelReply(response, model, (await replies.shift()?.()) ?? '22');
      });
      await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
      const gatewayAddress = gateway.address();
      assert.ok(gatewayAddress && typeof gatewayAddress === 'object');
      const pairing = randomUUID();
      const app = await createApp({
        root: directory,
        data: join(directory, 'data'),
        nativeExecution: native,
        desktopPairing: pairing,
      });
      try {
        app.store.setConfig({
          ...app.store.config(),
          gateway: `http://127.0.0.1:${gatewayAddress.port}`,
          model,
          managedGateway: false,
        });
        await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
        const address = app.server.address();
        assert.ok(address && typeof address === 'object');
        const origin = `http://127.0.0.1:${address.port}`;
        const initial = await fetch(origin + '/api/bootstrap', {
          headers: { [desktopPairingHeader]: pairing },
        });
        const { csrfToken } = z.object({ csrfToken: z.string() }).parse(await initial.json());
        async function post(path: string, body: unknown, status: number, method = 'POST') {
          const response = await fetch(origin + path, {
            method,
            headers: {
              'content-type': 'application/json',
              'x-atelier-token': csrfToken,
              [desktopPairingHeader]: pairing,
            },
            body: JSON.stringify(body),
          });
          const data: unknown = await response.json();
          assert.equal(response.status, status, JSON.stringify(data));
          return data;
        }
        const entity = z.object({ id: z.uuid() });
        const { project } = z
          .object({ project: entity })
          .parse(await post('/api/projects', { path: projectPath }, 201));
        const { session } = z
          .object({ session: entity })
          .parse(await post('/api/sessions', { projectId: project.id }, 201));
        const prompt = '先只读排查登录失败，汇报证据，不修改文件。';
        const message = async (text: string, selected?: string) =>
          z.object({ run: entity }).parse(
            await post(
              `/api/sessions/${session.id}/messages`,
              {
                text,
                model: selected,
                mode: native ? 'edit' : 'readonly',
                executionPreference: native ? 'native-v1' : 'project-v1',
                idempotencyKey: randomUUID(),
              },
              202,
            ),
          ).run.id;
        const finished = async (id: string) => {
          const deadline = AbortSignal.timeout(15_000);
          while (!app.store.get('runs', id).endedAt)
            await once(app.store.events, 'event', { signal: deadline });
          const run = app.store.get('runs', id);
          assert.equal(run.status, 'completed', run.error ?? '');
          return {
            run,
            plans: app.store.runHistory(id).events.filter(({ type }) => type === 'plan.updated'),
          };
        };
        const requestAt = (index: number) => {
          const incoming = z
            .object({
              system: z.union([z.string(), z.array(z.object({ text: z.string() }))]),
              model: z.string(),
              tools: z.array(z.object({ name: z.string(), description: z.string() })),
              messages: z.array(z.unknown()),
            })
            .parse(requests[index]);
          const guidance =
            typeof incoming.system === 'string'
              ? incoming.system
              : incoming.system.map(({ text }) => text).join('\n');
          return { ...incoming, guidance, names: incoming.tools.map(({ name }) => name) };
        };
        const saved = await fetch(origin + settingsPath, {
          headers: { [desktopPairingHeader]: pairing },
        });
        assert.equal(saved.status, 200);
        assert.deepEqual(await saved.json(), { mode: 'auto', prompt: null, modelOverrides: [] });
        const started = await message(prompt);
        await firstResponseReady;
        try {
          await post(settingsPath, { mode: 'off' }, 200, 'PATCH');
        } finally {
          releaseFirst();
        }
        const first = await finished(started);
        assert.deepEqual(first.run.plan, steps);
        assert.equal(first.plans.length, 1);
        assert.ok(JSON.stringify(requestAt(0).messages).includes(prompt));
        assert.ok(requestAt(0).names.includes(planName));
        assert.ok(requestAt(0).names.includes(todoName));
        assert.equal(
          requestAt(0).names.some((name) => ['Write', 'Edit', 'Bash'].includes(name)),
          native,
        );
        assert.match(requestAt(0).guidance, /关键材料缺失/);
        assert.match(
          requestAt(0).tools.find(({ name }) => name === planName)?.description ?? '',
          /observable completion check/i,
        );

        const sdkId = app.store.get('sessions', session.id).sdkSessionId;
        assert.ok(sdkId);
        const disabledIndex = requests.length;
        replies.push(() => [
          { name: planName, id: 'toolu_block_mcp', input: { steps } },
          { name: todoName, id: 'toolu_block_native', input: { todos: steps } },
        ]);
        const disabled = await finished(await message('请跟踪进度。'));
        assert.deepEqual(disabled.run.plan, []);
        assert.equal(app.store.get('sessions', session.id).sdkSessionId, sdkId);
        assert.equal(disabled.plans.length, 0);
        assert.ok(
          !requestAt(disabledIndex).names.some((name) =>
            [planName, todoName, 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(name),
          ),
        );
        assert.doesNotMatch(requestAt(disabledIndex).guidance, /关键材料缺失/);

        const overridden = 'other-plan-fixture';
        const custom = '按已核对工单的顺序记录每一步。';
        await post(
          settingsPath,
          { prompt: custom, modelOverride: { model: overridden, mode: 'on-request' } },
          200,
          'PATCH',
        );
        const simpleIndex = requests.length;
        const simple = await finished(await message('只回复 22。', overridden));
        assert.deepEqual(simple.run.plan, []);
        assert.equal(simple.plans.length, 0);
        assert.equal(requestAt(simpleIndex).model, overridden);
        assert.match(requestAt(simpleIndex).guidance, /仅在用户明确要求/);
        assert.ok(requestAt(simpleIndex).guidance.includes(custom));
        assert.equal(requests.length, simpleIndex + 1);

        const completed = steps.map(({ content }) => ({ content, status: 'completed' }));
        replies.push(
          () => [
            {
              name: todoName,
              id: 'toolu_native',
              input: { todos: steps.map((step) => ({ ...step, activeForm: step.content })) },
            },
          ],
          () => [{ name: planName, id: 'toolu_workbench', input: { steps: completed } }],
          () => '已完成。',
        );
        const explicit = await finished(await message('请列出清单并跟踪进度。', overridden));
        assert.deepEqual(
          explicit.plans.map(({ payload }) => payload.plan),
          [steps, completed],
        );
        assert.deepEqual(explicit.run.plan, completed);
        assert.deepEqual(app.store.get('runs', started).plan, steps);

        const correctionIndex = requests.length;
        replies.push(
          () => '21',
          () => '22',
        );
        const correctedId = await message('只回复 22。', overridden);
        assert.deepEqual((await finished(correctedId)).plans, []);
        const receipts = app.store
          .runHistory(correctedId)
          .events.filter(({ type }) => type === 'run.acceptance_checked')
          .map(({ payload }) => acceptanceReceipt.parse(payload));
        assert.deepEqual(
          receipts.map(({ correctionRequested }) => correctionRequested),
          [true, false],
        );
        assert.equal(requests.length, correctionIndex + 2);

        const scheduleIndex = requests.length;
        replies.push(
          () => [{ name: planName, id: 'toolu_scheduled', input: { steps } }],
          () => '已记录定时任务清单。',
        );
        const { task } = z.object({ task: entity }).parse(
          await post(
            '/api/schedules',
            {
              projectId: project.id,
              title: '测试任务规划',
              prompt: '请列出排查计划并跟踪进度。',
              timing: { kind: 'once', runAt: new Date(Date.now() + 1200).toISOString() },
              timeZone: 'UTC',
              model: overridden,
              mode: native ? 'edit' : 'readonly',
              executionPreference: native ? 'native-v1' : 'project-v1',
            },
            201,
          ),
        );
        const scheduleDeadline = AbortSignal.timeout(10_000);
        let scheduledId: string | null | undefined;
        while (!scheduledId) {
          scheduledId = app.schedules.listRuns(task.id).at(0)?.runId;
          if (!scheduledId) await delay(50, undefined, { signal: scheduleDeadline });
        }
        const scheduled = await finished(scheduledId);
        assert.equal(scheduled.run.scheduleMeta?.triggerKind, 'scheduled');
        assert.equal(scheduled.run.config.model, overridden);
        assert.deepEqual(scheduled.run.plan, steps);
        assert.equal(scheduled.plans.length, 1);
        assert.match(requestAt(scheduleIndex).guidance, /仅在用户明确要求/);

        if (!native) {
          const { agent } = z.object({ agent: z.object({ revisionId: z.string() }) }).parse(
            await post(
              `/api/projects/${project.id}/agents`,
              {
                name: '只读分析',
                description: '核对材料',
                instructions: '根据材料回答问题。',
                mode: 'readonly',
                starters: [],
                capabilities: ['read'],
                skills: [],
                mcp: [],
              },
              201,
            ),
          );
          const restricted = z.object({ session: entity }).parse(
            await post(
              '/api/sessions',
              {
                projectId: project.id,
                agentRevisionId: agent.revisionId,
              },
              201,
            ),
          ).session;
          const agentIndex = requests.length;
          const agentRun = z
            .object({ run: entity })
            .parse(
              await post(
                `/api/sessions/${restricted.id}/messages`,
                { text: '请列清单。', model: overridden, idempotencyKey: randomUUID() },
                202,
              ),
            ).run.id;
          assert.deepEqual((await finished(agentRun)).plans, []);
          assert.ok(
            !requestAt(agentIndex).names.some((name) => [planName, todoName].includes(name)),
          );
        }

        const reset = await post(
          settingsPath,
          { prompt: null, modelOverride: { model: overridden, mode: null } },
          200,
          'PATCH',
        );
        assert.deepEqual(reset, { mode: 'off', prompt: null, modelOverrides: [] });
        await post(settingsPath, { mode: 'unknown' }, 400, 'PATCH');
      } finally {
        releaseFirst();
        await app.close();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
