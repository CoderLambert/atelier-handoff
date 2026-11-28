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
import { z } from 'zod';
import { createApp } from '../server/app.js';
import { desktopPairingHeader } from '../shared/desktop-host.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const planName = 'mcp__atelier__update_plan';
const model = 'plan-fixture';
const steps = [
  { content: '只读核对登录入口和错误证据', status: 'in_progress' },
  { content: '汇报已确认原因、证据和待确认项', status: 'pending' },
];

for (const native of [false, true]) {
  test(
    `${native ? 'native' : 'controlled readonly'} runs send planning guidance to the SDK and save the tool plan`,
    { timeout: 25_000, skip: native && process.platform !== 'linux' },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'atelier-plan-generation-'));
      const projectPath = join(directory, 'project');
      await mkdir(projectPath);
      const requests: unknown[] = [];
      const gateway = createServer(async (request, response) => {
        if (request.method !== 'POST' || !request.url?.startsWith('/v1/messages')) {
          response.end('{}');
          return;
        }
        request.setEncoding('utf8');
        let text = '';
        for await (const chunk of request) text += String(chunk);
        requests.push(JSON.parse(text));
        sendModelReply(
          response,
          model,
          requests.length === 1
            ? [{ name: planName, id: 'toolu_plan', input: { steps } }]
            : '已记录只读排查清单。',
        );
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
        async function post(path: string, body: unknown, status: number) {
          const response = await fetch(origin + path, {
            method: 'POST',
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
        const { run } = z.object({ run: entity }).parse(
          await post(
            `/api/sessions/${session.id}/messages`,
            {
              text: prompt,
              mode: native ? 'edit' : 'readonly',
              executionPreference: native ? 'native-v1' : 'project-v1',
              idempotencyKey: randomUUID(),
            },
            202,
          ),
        );
        const deadline = AbortSignal.timeout(15_000);
        while (!app.store.get('runs', run.id).endedAt)
          await once(app.store.events, 'event', { signal: deadline });

        const result = app.store.get('runs', run.id);
        assert.equal(result.status, 'completed');
        assert.deepEqual(result.plan, steps);
        assert.ok(
          app.store.runHistory(run.id).events.some((event) => event.type === 'plan.updated'),
        );

        const first = z
          .object({
            system: z.union([z.string(), z.array(z.object({ text: z.string() }))]),
            tools: z.array(z.object({ name: z.string(), description: z.string() })),
            messages: z.array(z.unknown()),
          })
          .parse(requests[0]);
        const guidance =
          typeof first.system === 'string'
            ? first.system
            : first.system.map(({ text }) => text).join('\n');
        for (const instruction of [
          '每项明确要求',
          '每个步骤',
          '关键材料',
          '先只读',
          '用户中途修正',
          '完成条件',
        ])
          assert.ok(
            guidance.includes(instruction),
            `Model request must include planning rule: ${instruction}`,
          );
        assert.ok(JSON.stringify(first.messages).includes(prompt));
        const tool = first.tools.find(({ name }) => name === planName);
        assert.match(tool?.description ?? '', /observable completion check/i);
        assert.equal(
          first.tools.some(({ name }) => ['Write', 'Edit', 'Bash'].includes(name)),
          native,
        );
      } finally {
        await app.close();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
