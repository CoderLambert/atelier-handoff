/**
 * @file 验证原生 SDK 并行子代理的权限归属与独立停止。
 * @implementation 在隔离项目和回环网关中核对三条并行分支的实际文件写入、审批回执及单分支和整轮取消结果。
 * @updated 2026-11-22T16:30:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProjectWrites } from '../server/subagent-run.js';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRunner } from '../server/agent.js';
import { FileRecords } from '../server/artifacts.js';
import { PermissionService } from '../server/permissions.js';
import { Store } from '../server/store.js';
import { emptyDraft, now, type Run } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const model = 'atelier-subagent-fixture';
const main = 'MAIN_ATELIER_FIXTURE';
const children = ['CHILD_ALPHA', 'CHILD_BETA', 'CHILD_GAMMA'];

for (const scenario of ['approve', 'stop-all', 'stop-one'] as const) {
  const stop = scenario === 'stop-all';
  const single = scenario === 'stop-one';
  test(
    `real SDK runs three same-batch tasks before approval release and ${stop ? 'cancels all approvals' : single ? 'stops only the selected branch and cancels its pending approval' : 'preserves each approval and result'}`,
    { timeout: 45_000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'atelier-subagent-runner-'));
      const projectPath = join(directory, 'project');
      await mkdir(projectPath);
      const sample = join(projectPath, 'sample.txt');
      await writeFile(sample, 'old\n');
      const errors: unknown[] = [];
      const childRequests: string[] = [];
      const gateway = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const request = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(new URL(req.url ?? '/', 'http://127.0.0.1').pathname, '/v1/messages');
          assert.equal(request.model, model);
          const text = JSON.stringify(request.messages);
          const child = !text.includes(main)
            ? children.find((value) => text.includes(value))
            : undefined;
          if (child) {
            assert.ok(
              request.tools.some(
                ({ name }: { name: string }) => name === 'mcp__atelier__edit_file',
              ),
            );
            assert.ok(
              !request.tools.some(({ name }: { name: string }) =>
                ['Agent', 'Task', 'Bash', 'Write'].includes(name),
              ),
            );
            if (text.includes(`toolu_${child}`)) {
              sendModelReply(res, model, `REPORT_${child}`);
            } else {
              childRequests.push(child);
              sendModelReply(res, model, [
                {
                  name: 'mcp__atelier__edit_file',
                  id: `toolu_${child}`,
                  input: {
                    path: 'sample.txt',
                    oldText: 'old',
                    newText: 'new',
                    reason: 'Fixture edit',
                  },
                },
              ]);
            }
          } else if (text.includes('toolu_spawn_')) {
            assert.ok(
              children
                .filter((name) => !single || name !== 'CHILD_BETA')
                .every((name) => text.includes(`REPORT_${name}`)),
              text.slice(-1200),
            );
            sendModelReply(res, model, 'PARENT_SUMMARY');
          } else {
            assert.ok(text.includes(main));
            sendModelReply(
              res,
              model,
              children.map((prompt, index) => ({
                name: 'Agent',
                id: `toolu_spawn_${index}`,
                input: {
                  description: `Fixture task ${index}`,
                  prompt,
                  subagent_type: 'atelier-worker',
                  run_in_background: false,
                },
              })),
            );
          }
        } catch (error) {
          errors.push(error);
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message: String(error) },
            }),
          );
        }
      });
      await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
      const address = gateway.address();
      assert.ok(address && typeof address === 'object');
      const store = new Store(join(directory, 'data'));
      const permissions = new PermissionService(store);
      const runner = new AgentRunner(store, permissions, new FileRecords(store));
      const project = store.put('projects', {
        id: randomUUID(),
        name: 'Fixture',
        path: projectPath,
        branch: '',
        available: true,
        createdAt: now(),
      });
      const session = store.put('sessions', {
        id: randomUUID(),
        projectId: project.id,
        title: 'Fixture',
        status: 'active',
        sdkSessionId: null,
        draft: emptyDraft(),
        createdAt: now(),
        updatedAt: now(),
      });
      const run: Run = store.put('runs', {
        id: randomUUID(),
        projectId: project.id,
        sessionId: session.id,
        prompt: main,
        mode: 'edit',
        status: 'queued',
        createdAt: now(),
        startedAt: null,
        endedAt: null,
        reason: null,
        error: null,
        retryOf: null,
        contextPaths: [],
        attachmentIds: [],
        plan: [],
        usage: null,
        config: {
          gateway: `http://127.0.0.1:${address.port}`,
          model,
          limitExecution: true,
          maxTurns: 10,
          timeoutMs: 25_000,
        },
      });
      try {
        const done = runner.start(run, main);
        const deadline = performance.now() + 12_000;
        while (
          store.list('permissions').length < children.length &&
          performance.now() < deadline &&
          !errors.length
        )
          await delay(20);
        const snapshot = store.sessionSnapshots.read(session.id);
        const tasks = snapshot.subagents;
        assert.equal(
          tasks.length,
          3,
          JSON.stringify({
            errors: errors.map(String),
            run: store.get('runs', run.id),
            tools: snapshot.tools,
            events: snapshot.events,
          }),
        );
        assert.ok(tasks.every(({ status }) => status === 'running'));
        assert.deepEqual(childRequests.sort(), [...children].sort());
        assert.equal(snapshot.permissions.length, 3);
        const alpha = snapshot.permissions.find(({ toolCallId }) =>
          toolCallId.endsWith('toolu_CHILD_ALPHA'),
        );
        const beta = snapshot.permissions.find(({ toolCallId }) =>
          toolCallId.endsWith('toolu_CHILD_BETA'),
        );
        const gamma = snapshot.permissions.find(({ toolCallId }) =>
          toolCallId.endsWith('toolu_CHILD_GAMMA'),
        );
        assert.equal(alpha?.subagentId, tasks.find(({ title }) => title === 'Fixture task 0')?.id);
        assert.equal(beta?.subagentId, tasks.find(({ title }) => title === 'Fixture task 1')?.id);
        assert.equal(gamma?.subagentId, tasks.find(({ title }) => title === 'Fixture task 2')?.id);
        assert.ok(
          alpha?.status === 'pending' && beta?.status === 'pending' && gamma?.status === 'pending',
        );
        assert.equal(await readFile(sample, 'utf8'), 'old\n');
        if (stop) runner.stop(run.id);
        else {
          await permissions.decide(gamma.id, 'deny', gamma.version);
          if (single) {
            assert.ok(beta.subagentId);
            await runner.stopSubagent(run.id, beta.subagentId);
            assert.equal(store.get('permissions', beta.id).status, 'canceled');
          } else await permissions.decide(beta.id, 'deny', beta.version);
          await permissions.decide(alpha.id, 'allow', alpha.version);
        }
        await done;
        assert.deepEqual(errors, []);
        const final = store.sessionSnapshots.read(session.id);
        assert.equal(store.get('runs', run.id).status, stop ? 'stopped' : 'completed');
        assert.deepEqual(
          final.subagents.map(({ status }) => status),
          final.subagents.map((task) =>
            stop || (single && task.id === beta.subagentId) ? 'stopped' : 'completed',
          ),
        );
        assert.equal(await readFile(sample, 'utf8'), stop ? 'old\n' : 'new\n');
        if (stop) assert.ok(final.permissions.every(({ status }) => status === 'canceled'));
        else {
          assert.deepEqual(
            final.subagents
              .filter((task) => !single || task.id !== beta.subagentId)
              .map(({ summary }) => summary)
              .sort(),
            children
              .filter((name) => !single || name !== 'CHILD_BETA')
              .map((name) => `REPORT_${name}`),
          );
          assert.equal(final.messages.at(-1)?.text, 'PARENT_SUMMARY');
          assert.equal(final.tools.find(({ id }) => id === alpha.toolCallId)?.status, 'succeeded');
          assert.equal(
            final.tools.find(({ id }) => id === beta.toolCallId)?.status,
            single ? 'canceled' : 'denied',
          );
          assert.equal(final.tools.find(({ id }) => id === gamma.toolCallId)?.status, 'denied');
        }
      } finally {
        await runner.shutdown();
        store.close();
        gateway.closeAllConnections();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test('a queued write waits for the execution-time authorization check', async () => {
  function gate() {
    let open = () => {};
    let fail = (_error: Error) => {};
    const promise = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    return { promise, open, fail };
  }
  const writes = new ProjectWrites();
  const occupied = gate();
  const verify = gate();
  const verifying = gate();
  const first = writes.run(
    () => {},
    () => occupied.promise,
  );
  let written = false;
  const pending = writes.run(
    () => {
      verifying.open();
      return verify.promise;
    },
    async () => {
      written = true;
    },
  );
  const rejected = assert.rejects(pending, /workspace moved/u);
  occupied.open();
  await verifying.promise;
  verify.fail(new Error('workspace moved'));
  await first;
  await rejected;
  assert.equal(written, false);
});
