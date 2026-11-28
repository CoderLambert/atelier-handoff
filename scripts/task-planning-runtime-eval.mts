/**
 * @file 配对评测两份工作树上的真实任务规划运行。
 * @implementation 将同一套合成夹具提交给真实 SDK 和指定的回环模型网关，记录模型请求、交付物及实际验收。
 * @updated 2026-11-28T21:12:24+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import { acceptanceReceipt } from '../shared/run-acceptance.js';
import { gatewayModelSchema, reasoningEfforts } from '../shared/models.js';
import { snapshot, writeFixture } from './harness-eval.mjs';
import {
  gradeDelivery,
  gradePlan,
  makeTrial,
  taskIds,
  type Delivery,
  type TaskId,
} from './task-plan-eval-cases.mjs';
import { verifyHtml } from './task-plan-eval.mjs';
import type { createApp } from '../server/app.js';

const [baselinePath, resultsPath, taskList] = process.argv.slice(2);
assert.ok(
  baselinePath && resultsPath,
  'Usage: node --import tsx scripts/task-planning-runtime-eval.mts BASELINE_WORKTREE NEW_OUTPUT_DIR [comma-separated tasks]',
);
const candidate = resolve(import.meta.dirname, '..');
const baseline = resolve(baselinePath);
assert.notEqual(candidate, baseline);
const out = resolve(resultsPath);
await mkdir(out);
const tasks = z.array(z.enum(taskIds)).parse(taskList?.split(',') ?? taskIds);
const routedGateway = process.env.ATELIER_TASK_PLAN_GATEWAY;
const gatewayToken = process.env.ATELIER_TASK_PLAN_GATEWAY_TOKEN;
const requestedEffort = process.env.ATELIER_TASK_PLAN_EFFORT;
const effort = requestedEffort ? z.enum(reasoningEfforts).parse(requestedEffort) : undefined;
const model = gatewayModelSchema.shape.id.parse(
  routedGateway ? process.env.ATELIER_TASK_PLAN_MODEL : 'qwen3.5:9b',
);
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.ATELIER_TASK_PLAN_OLLAMA_PORT ?? 11434);
const upstream = routedGateway ?? 'http://127.0.0.1:' + port;
assert.match(
  upstream,
  /^http:\/\/127\.0\.0\.1:\d{1,5}$/u,
  'The model gateway must be on loopback.',
);
assert.ok(!routedGateway || effort, 'Set ATELIER_TASK_PLAN_EFFORT for routed comparisons.');

const gatewayHeaders: Record<string, string> = gatewayToken
  ? { Authorization: 'Bearer ' + gatewayToken }
  : {};
async function describeUpstream() {
  if (routedGateway) return { kind: 'routed', model, effort, upstream };
  const metadata = z
    .object({
      models: z.array(z.object({ name: z.string(), digest: z.string(), size: z.number() })),
    })
    .parse(await (await fetch(upstream + '/api/tags', { redirect: 'error' })).json());
  const installed = metadata.models.find(({ name, size }) => name === model && size > 1_000_000);
  assert.ok(installed, 'The installed qwen3.5:9b model is required');
  const version: unknown = await (
    await fetch(upstream + '/api/version', { redirect: 'error' })
  ).json();
  return { kind: 'ollama', model, installed, version };
}
const modelSource = await describeUpstream();
const entity = z.object({ id: z.uuid() });

type ModelRequest = {
  model: string;
  tools: string[];
  messages: number;
  effort?: string;
  status?: number;
  responseModel?: string;
};

const streamStart = z.object({
  type: z.literal('message_start'),
  message: z.object({ model: z.string() }),
});

async function* responseChunks(body: NonNullable<Response['body']>, request: ModelRequest) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (routedGateway && !request.responseModel) {
        const lines = (pending + decoder.decode(chunk.value, { stream: true })).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:') || !line.includes('"message_start"')) continue;
          const parsed = streamStart.parse(JSON.parse(line.slice(5)));
          request.responseModel = parsed.message.model;
          assert.equal(request.responseModel, model, 'Gateway returned a different model');
          break;
        }
      }
      yield chunk.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function trial(root: string, task: TaskId, folder: string) {
  await mkdir(folder);
  const scratch = await mkdtemp(join(tmpdir(), 'atelier-planning-eval-'));
  const projectPath = join(scratch, 'project');
  const fixture = makeTrial(task);
  await writeFixture(projectPath, fixture);
  const requests: ModelRequest[] = [];
  const errors: string[] = [];
  const gateway = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/v1/messages') {
      res.end('{}');
      return;
    }
    try {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const data = z
        .looseObject({
          model: z.literal(model),
          tools: z
            .array(
              z.looseObject({ name: z.string(), input_schema: z.record(z.string(), z.unknown()) }),
            )
            .optional(),
          messages: z.array(z.unknown()),
          output_config: z.looseObject({ effort: z.string().optional() }).optional(),
        })
        .parse(JSON.parse(raw));
      const request: ModelRequest = {
        model,
        effort: data.output_config?.effort,
        tools: (data.tools ?? []).map(({ name }) => name),
        messages: data.messages.length,
      };
      requests.push(request);
      if (effort) assert.equal(request.effort, effort, 'SDK used a different reasoning effort');
      const response = await fetch(upstream + '/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(routedGateway ? gatewayHeaders : { 'x-api-key': 'ollama' }),
        },
        body: JSON.stringify(
          routedGateway
            ? data
            : {
                ...data,
                temperature: 0,
                max_tokens: 2400,
                thinking: { type: 'disabled' },
              },
        ),
        redirect: 'error',
        signal: AbortSignal.timeout(100_000),
      });
      request.status = response.status;
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      });
      if (!response.body) return res.end();
      await pipeline(Readable.from(responseChunks(response.body, request)), res);
    } catch (error) {
      errors.push(String(error));
      if (!res.headersSent) res.writeHead(502);
      res.end('{}');
    }
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const { createApp: start }: { createApp: typeof createApp } = await import(
    pathToFileURL(join(root, 'server/app.ts')).href
  );
  const app = await start({ root, data: join(scratch, 'data') });
  try {
    app.store.setConfig({
      ...app.store.config(),
      gateway: 'http://127.0.0.1:' + address.port,
      model,
      managedGateway: false,
      magpieEnabled: false,
      limitExecution: true,
      maxTurns: 10,
      timeoutMs: 180_000,
    });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const apiAddress = app.server.address();
    assert.ok(apiAddress && typeof apiAddress !== 'string');
    const origin = 'http://127.0.0.1:' + apiAddress.port;
    const { csrfToken } = z
      .object({ csrfToken: z.string() })
      .parse(await (await fetch(origin + '/api/bootstrap')).json());
    async function post(path: string, data: unknown, status: number): Promise<unknown> {
      const response = await fetch(origin + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
        body: JSON.stringify(data),
      });
      const parsed: unknown = await response.json();
      assert.equal(response.status, status, JSON.stringify(parsed));
      return parsed;
    }
    const { project } = z
      .object({ project: entity })
      .parse(await post('/api/projects', { path: projectPath }, 201));
    const { session } = z
      .object({ session: entity })
      .parse(await post('/api/sessions', { projectId: project.id }, 201));
    const startTime = performance.now();
    const {
      run: { id },
    } = z.object({ run: entity }).parse(
      await post(
        '/api/sessions/' + session.id + '/messages',
        {
          text: fixture.request,
          mode: 'readonly',
          effort,
          executionPreference: 'project-v1',
          idempotencyKey: randomUUID(),
        },
        202,
      ),
    );
    const deadline = AbortSignal.timeout(190_000);
    while (!app.store.get('runs', id).endedAt)
      await once(app.store.events, 'event', { signal: deadline });
    const elapsedMs = Math.round(performance.now() - startTime);
    const run = app.store.get('runs', id);
    const history = app.store.runHistory(id).events;
    const traces = app.store.repos.tools.listByRun(id);
    const reply =
      app.store
        .list('messages')
        .filter((message) => message.runId === id && message.role === 'assistant')
        .at(-1)?.text ?? '';
    const receipts = history
      .filter(({ type }) => type === 'run.acceptance_checked')
      .map(({ payload }) => acceptanceReceipt.parse(payload));
    const records = app.store.repos.artifacts.listByRun(id);
    const delivered: Delivery['files'] = [];
    for (const [index, artifact] of records.entries()) {
      const { bytes } = await app.files.content(artifact.id);
      await writeFile(join(folder, 'artifact-' + (index + 1)), bytes);
      delivered.push({ path: artifact.name, content: bytes.toString('utf8') });
    }
    const output = Object.fromEntries(delivered.map(({ path, content }) => [path, content]));
    const browser =
      runnerBrowser && task === 'html'
        ? await verifyHtml(runnerBrowser, output['handout.html'], folder)
        : {};
    const steps = run.plan.map(({ content }) => content);
    const planChecks = gradePlan(task, {
      kind: steps.length ? 'plan' : task === 'missing' ? 'clarify' : 'direct',
      reply,
      steps,
    });
    const files = await snapshot(projectPath);
    const deliveryChecks = {
      ...gradeDelivery(
        task,
        { reply, files: Object.entries(output).map(([path, content]) => ({ path, content })) },
        output,
        browser,
      ),
      completed: run.status === 'completed',
      preservedSources: Object.entries(fixture.files).every(
        ([path, content]) => files[path] === content,
      ),
    };
    const planCalls = traces.filter(
      ({ name }) => name === 'TodoWrite' || name === 'mcp__atelier__update_plan',
    ).length;
    const report = {
      task,
      root,
      modelSource,
      elapsedMs,
      requests,
      errors,
      modelVerified:
        !routedGateway ||
        (requests.length > 0 &&
          requests.every(
            (request) =>
              request.status === 200 &&
              request.responseModel === model &&
              request.effort === effort,
          )),
      planCalls,
      status: run.status,
      error: run.error,
      usage: run.usage,
      plan: run.plan,
      tools: traces.map(({ name, status }) => ({ name, status })),
      reply,
      receipts,
      artifacts: records,
      planChecks,
      deliveryChecks,
      planPass: Object.values(planChecks).every(Boolean),
      deliveryPass: Object.values(deliveryChecks).every(Boolean),
    };
    await writeFile(join(folder, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    await app.close();
    gateway.closeAllConnections();
    await new Promise<void>((done) => gateway.close(() => done()));
    await rm(scratch, { recursive: true, force: true });
  }
}

const runnerBrowser = tasks.includes('html')
  ? await chromium.launch({ executablePath: '/usr/bin/chromium', chromiumSandbox: true })
  : undefined;
try {
  for (const [index, task] of tasks.entries()) {
    const variants = ['baseline', 'candidate'] as const;
    for (const variant of index % 2 ? [...variants].reverse() : variants) {
      const report = await trial(
        variant === 'baseline' ? baseline : candidate,
        task,
        join(out, `${task}-${variant}`),
      );
      assert.ok(
        report.modelVerified,
        `Cannot verify ${model} ${effort ?? ''} for ${task}/${variant}; see receipt.json`,
      );
      console.log(
        JSON.stringify({
          task,
          variant,
          status: report.status,
          modelVerified: report.modelVerified,
          error: report.error,
          plan: report.planPass,
          delivery: report.deliveryPass,
          requests: report.requests.length,
          checklistCalls: report.planCalls,
          usage: report.usage,
          elapsedMs: report.elapsedMs,
        }),
      );
    }
  }
} finally {
  await runnerBrowser?.close();
}
