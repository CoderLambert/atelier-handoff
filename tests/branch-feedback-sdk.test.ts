/**
 * @file 验证真实 SDK 并行前台分支收到各自工具后的停滞反馈。
 * @implementation 用回环模型和请求屏障驱动两条分支重复读取相同目录，只虚拟 Date 跨过停滞阈值，核对模型上下文和轨迹归属。
 * @updated 2026-11-22T18:00:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { AgentRunner } from '../server/agent.js';
import { FileRecords } from '../server/artifacts.js';
import { PermissionService } from '../server/permissions.js';
import { Store } from '../server/store.js';
import { emptyDraft, now, type Run } from '../shared/types.js';
import { sendModelReply } from './fixtures/subagent-gateway.js';

const model = 'atelier-branch-feedback-fixture';
const main = 'MAIN_BRANCH_FEEDBACK_FIXTURE';
const children = ['BRANCH_FEEDBACK_ALPHA', 'BRANCH_FEEDBACK_BETA'] as const;
type Child = (typeof children)[number];
const [alpha, beta] = children;
const requestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z.array(z.object({ name: z.string() })),
});
const resultSchema = z.object({ type: z.literal('tool_result'), tool_use_id: z.string() });
const textSchema = z.object({ type: z.literal('text'), text: z.string() });
const feedbackText = '请根据已有证据提出新的可验证假设';
const hookContextPrefix = 'PostToolUse:mcp__atelier__list_files hook additional context: ';

function resultIds(request: z.infer<typeof requestSchema>): Set<string> {
  return new Set(
    request.messages.flatMap(({ content }) =>
      Array.isArray(content)
        ? content.flatMap((block: unknown) => {
            const result = resultSchema.safeParse(block);
            return result.success ? [result.data.tool_use_id] : [];
          })
        : [],
    ),
  );
}

const toolId = (child: Child, round: number) => `toolu_${child}_${round}`;

test(
  'real SDK delivers same-target feedback to both parallel foreground branches one millisecond apart with branch-owned trace entries',
  { timeout: 45_000 },
  async (context) => {
    // node:test isolates this file's process. Only Date changes: real timers and the SDK CLI
    // subprocess keep running normally, including cancellation and timeout cleanup.
    const epoch = Date.parse('2026-11-22T00:00:00.000Z');
    context.mock.timers.enable({ apis: ['Date'], now: epoch });
    const priorMode = process.env.ATELIER_HARNESS_PROGRESS;
    process.env.ATELIER_HARNESS_PROGRESS = 'feedback';
    const directory = await mkdtemp(join(tmpdir(), 'atelier-branch-feedback-sdk-'));
    const projectPath = join(directory, 'project');
    await mkdir(projectPath);
    await writeFile(join(projectPath, 'sample.txt'), 'synthetic branch feedback input\n');
    const errors: unknown[] = [];
    const requests = new Map<number, Map<Child, ServerResponse>>();
    const receivedFeedback = new Map<Child, string>();
    const requestCounts = new Map<Child, number>();
    const foreground = new Set<Child>();
    const store = new Store(join(directory, 'data'));
    const runner = new AgentRunner(store, new PermissionService(store), new FileRecords(store));
    const project = store.put('projects', {
      id: randomUUID(),
      name: 'Synthetic feedback fixture',
      path: projectPath,
      branch: '',
      available: true,
      createdAt: now(),
    });
    const session = store.put('sessions', {
      id: randomUUID(),
      projectId: project.id,
      title: 'Synthetic feedback fixture',
      status: 'active',
      sdkSessionId: null,
      draft: emptyDraft(),
      createdAt: now(),
      updatedAt: now(),
    });
    const sendRead = (res: ServerResponse, child: Child, round: number) =>
      sendModelReply(res, model, [
        { name: 'mcp__atelier__list_files', id: toolId(child, round), input: { path: '' } },
      ]);
    const gateway = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        assert.equal(new URL(req.url ?? '/', 'http://127.0.0.1').pathname, '/v1/messages');
        const decoded: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const request = requestSchema.parse(decoded);
        assert.equal(request.model, model);
        const text = JSON.stringify(request.messages);
        // Hook evidence can name sibling tools; identify a branch from its actual user brief.
        // The SDK sends the initial brief as text blocks, then normalizes it to a string.
        const firstUser = request.messages.find(({ role }) => role === 'user')?.content;
        const child = children.find(
          (candidate) =>
            firstUser === candidate ||
            (Array.isArray(firstUser) &&
              firstUser.some((block: unknown) => {
                const parsed = textSchema.safeParse(block);
                return parsed.success && parsed.data.text === candidate;
              })),
        );
        if (!child) {
          if (resultIds(request).has('toolu_spawn_feedback_0')) {
            for (const candidate of children) assert.ok(text.includes(`REPORT_${candidate}`));
            assert.ok(!text.includes(feedbackText), 'child feedback leaked into parent context');
            sendModelReply(res, model, 'PARENT_FEEDBACK_SUMMARY');
          } else {
            assert.ok(text.includes(main), `unrecognized model context: ${text}`);
            sendModelReply(
              res,
              model,
              children.map((prompt, index) => ({
                name: 'Agent',
                id: `toolu_spawn_feedback_${index}`,
                input: {
                  description: prompt,
                  prompt,
                  subagent_type: 'atelier-explore',
                  run_in_background: false,
                },
              })),
            );
          }
          return;
        }
        assert.ok(request.tools.some(({ name }) => name === 'mcp__atelier__list_files'));
        assert.ok(!request.tools.some(({ name }) => ['Agent', 'Task', 'Bash'].includes(name)));
        const results = resultIds(request);
        const round = [1, 2, 3].filter((index) => results.has(toolId(child, index))).length;
        assert.equal(
          requestCounts.get(child) ?? 0,
          round,
          `unexpected ${child} request order: ${text}`,
        );
        requestCounts.set(child, round + 1);
        const other = child === alpha ? beta : alpha;
        for (const index of [1, 2, 3])
          assert.ok(!results.has(toolId(other, index)), 'sibling tool result leaked into branch');
        if (round === 3) {
          const feedbackIndex = request.messages.findIndex(
            ({ role, content }) =>
              role === 'system' &&
              typeof content === 'string' &&
              content.startsWith(hookContextPrefix) &&
              content.includes(feedbackText),
          );
          const feedback = request.messages[feedbackIndex];
          assert.ok(
            feedback && typeof feedback.content === 'string',
            `${child} did not receive post-tool hook context: ${text.slice(-5000)}`,
          );
          const resultIndex = request.messages.findIndex(({ role, content }) =>
            role === 'user' && Array.isArray(content)
              ? content.some((block: unknown) => {
                  const result = resultSchema.safeParse(block);
                  return result.success && result.data.tool_use_id === toolId(child, 3);
                })
              : false,
          );
          assert.ok(resultIndex >= 0 && feedbackIndex > resultIndex);
          assert.ok(feedback.content.includes(toolId(child, 3)));
          receivedFeedback.set(child, feedback.content);
          if (child === alpha) {
            // Alpha has already consumed its hook context before beta's third tool runs.
            // A run-global cooldown would suppress beta's feedback at this instant.
            context.mock.timers.setTime(epoch + 60_001);
            const waiting = requests.get(2)?.get(beta);
            assert.ok(waiting, 'beta must already be waiting while alpha gets feedback');
            sendRead(waiting, beta, 3);
          }
          sendModelReply(res, model, `REPORT_${child}`);
          return;
        }
        assert.ok(!text.includes(feedbackText), 'feedback arrived before the elapsed threshold');
        const batch = requests.get(round) ?? new Map<Child, ServerResponse>();
        batch.set(child, res);
        requests.set(round, batch);
        if (batch.size !== children.length) return;
        const snapshot = store.sessionSnapshots.read(session.id);
        assert.equal(snapshot.subagents.length, 2);
        assert.ok(snapshot.subagents.every(({ status }) => status === 'running'));
        const alphaResponse = batch.get(alpha);
        const betaResponse = batch.get(beta);
        assert.ok(alphaResponse && betaResponse);
        if (round === 0) {
          for (const candidate of children) foreground.add(candidate);
          sendRead(alphaResponse, alpha, 1);
          sendRead(betaResponse, beta, 1);
        } else if (round === 1) {
          context.mock.timers.setTime(epoch + 30_000);
          sendRead(alphaResponse, alpha, 2);
          sendRead(betaResponse, beta, 2);
        } else {
          context.mock.timers.setTime(epoch + 60_000);
          sendRead(alphaResponse, alpha, 3);
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
    const run: Run = store.put('runs', {
      id: randomUUID(),
      projectId: project.id,
      sessionId: session.id,
      prompt: main,
      mode: 'readonly',
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
      await runner.start(run, main);
      const snapshot = store.sessionSnapshots.read(session.id);
      const diagnostics = JSON.stringify({
        errors: errors.map(String),
        run: store.get('runs', run.id),
      });
      assert.deepEqual(errors.map(String), [], diagnostics);
      assert.equal(store.get('runs', run.id).status, 'completed', diagnostics);
      assert.deepEqual([...foreground].sort(), [...children].sort());
      assert.deepEqual([...receivedFeedback.keys()].sort(), [...children].sort());
      assert.equal(snapshot.messages.at(-1)?.text, 'PARENT_FEEDBACK_SUMMARY');
      assert.ok(snapshot.subagents.every(({ status }) => status === 'completed'));
      assert.equal(snapshot.permissions.length, 0);
      const trace = store
        .runHistory(run.id)
        .events.filter(
          ({ type, payload }) => type === 'harness.progress' && payload.kind === 'feedback',
        );
      assert.equal(trace.length, 2, JSON.stringify(trace));
      assert.equal(Date.parse(trace[1]?.at ?? '') - Date.parse(trace[0]?.at ?? ''), 1);
      for (const child of children) {
        const branch = snapshot.subagents.find(({ title }) => title === child);
        assert.ok(branch);
        const tools = snapshot.tools.filter(({ subagentId }) => subagentId === branch.id);
        assert.equal(tools.length, 3);
        assert.ok(tools.every(({ status }) => status === 'succeeded'));
        const trigger = tools.find(({ id }) => id.endsWith(`:${toolId(child, 3)}`));
        assert.ok(trigger);
        const feedback = trace.find(({ payload }) => payload.toolCallId === trigger.id);
        assert.ok(feedback, `missing feedback trace for ${child}`);
        assert.equal(feedback.payload.actorId, branch.id);
        assert.equal(trigger.id.split(':').length, 3, 'tool ID must include the SDK branch ID');
        assert.ok(typeof feedback.payload.summary === 'string');
        const received = receivedFeedback.get(child);
        assert.ok(received);
        assert.ok(
          feedback.payload.summary.endsWith(received.slice(hookContextPrefix.length)),
          JSON.stringify({ child, received, trace: feedback.payload }),
        );
        assert.ok(Number(feedback.payload.elapsedMs) >= 60_000);
      }
    } finally {
      await runner.shutdown();
      store.close();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
      if (priorMode === undefined) delete process.env.ATELIER_HARNESS_PROGRESS;
      else process.env.ATELIER_HARNESS_PROGRESS = priorMode;
      context.mock.timers.reset();
    }
  },
);
