/**
 * @file 验证主运行交付验收、澄清等待及实际 SDK 请求。
 * @implementation 使用锁定 SDK、回环响应器和临时 SQLite 核对验收修正、澄清展示、插话与等待期间的操作门禁。
 * @updated 2026-11-29T00:37:27+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { AgentRunner } from '../server/agent.js';
import { FileRecords } from '../server/artifacts.js';
import { PermissionService } from '../server/permissions.js';
import { Store } from '../server/store.js';
import { RunAcceptanceStop } from '../server/modules/runs/acceptance-stop.js';
import { emptyDraft, now, type Run } from '../shared/types.js';
import { sendModelReply, type FixtureTool } from './fixtures/subagent-gateway.js';

const model = 'atelier-acceptance-fixture';
const receipt = z.object({
  phase: z.enum(['initial', 'recheck']),
  correctionRequested: z.boolean(),
  checks: z.array(
    z.object({
      status: z.string(),
      criterion: z.string(),
      detail: z.string(),
      artifactId: z.string().optional(),
      fingerprint: z.string().optional(),
    }),
  ),
});

type Reply = string | FixtureTool[];
type ReplyStep = Reply | ((runner: AgentRunner, run: Run, store: Store) => Promise<Reply>);

function publish(id: string, name: string, content: string): FixtureTool[] {
  return [{ name: 'mcp__atelier__publish_artifact', id, input: { name, content } }];
}

function insertBeforeReply(text: string, reply: string): ReplyStep {
  return async (runner, run) => {
    await runner.insert(run.id, {
      text,
      id: randomUUID(),
      priority: 'next',
      dispatched() {},
      confirmed() {},
      released() {},
    });
    return reply;
  };
}

function fixture(store: Store, projectPath: string, prompt: string, gateway: string): Run {
  const project = store.put('projects', {
    id: randomUUID(),
    name: 'Acceptance fixture',
    path: projectPath,
    branch: '',
    available: true,
    createdAt: now(),
  });
  const session = store.put('sessions', {
    id: randomUUID(),
    projectId: project.id,
    title: 'Acceptance fixture',
    status: 'active',
    sdkSessionId: null,
    draft: emptyDraft(),
    createdAt: now(),
    updatedAt: now(),
  });
  return store.put('runs', {
    id: randomUUID(),
    projectId: project.id,
    sessionId: session.id,
    prompt,
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
      gateway,
      model,
      limitExecution: true,
      maxTurns: 4,
      timeoutMs: 30_000,
    },
  });
}

async function runScenario(prompt: string, answers: ReplyStep[], edit = false) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-acceptance-sdk-'));
  const projectPath = join(directory, 'project');
  await mkdir(projectPath);
  const requests: string[] = [];
  let run: Run;
  const errors: unknown[] = [];
  const gateway = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = z
        .object({ messages: z.array(z.unknown()) })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(JSON.stringify(body.messages));
      const step = answers[requests.length - 1] ?? 'UNEXPECTED_MODEL_REQUEST';
      const reply = typeof step === 'function' ? await step(runner, run, store) : step;
      if (!response.destroyed) sendModelReply(response, model, reply);
    } catch (error) {
      errors.push(error);
      response.writeHead(400).end();
    }
  });
  const store = new Store(join(directory, 'data'));
  const runner = new AgentRunner(store, new PermissionService(store), new FileRecords(store));
  const previousToken = process.env.ATELIER_GATEWAY_TOKEN;
  process.env.ATELIER_GATEWAY_TOKEN = 'synthetic-acceptance-test';
  try {
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const address = gateway.address();
    assert.ok(address && typeof address === 'object');
    run = fixture(store, projectPath, prompt, `http://127.0.0.1:${address.port}`);
    if (edit) run = store.update('runs', run.id, { mode: 'edit', approvalMode: 'automatic' });
    await runner.start(run, prompt);
    assert.deepEqual(errors, []);
    const history = store.runHistory(run.id).events;
    const events = history.filter(({ type }) => type === 'run.acceptance_checked');
    return {
      requests,
      run: store.get('runs', run.id),
      artifacts: store.repos.artifacts.listByRun(run.id),
      receipts: events.map(({ payload }) => receipt.parse(payload)),
      history,
      projectFiles: await readdir(projectPath),
      messages: store.list('messages').filter(({ runId }) => runId === run.id),
    };
  } finally {
    await runner.shutdown();
    if (previousToken === undefined) delete process.env.ATELIER_GATEWAY_TOKEN;
    else process.env.ATELIER_GATEWAY_TOKEN = previousToken;
    store.close();
    gateway.closeAllConnections();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('real SDK Stop repairs a computed answer that violates the result-only format', async () => {
  const result = await runScenario('只回复计算结果。8 加 14 等于多少？', ['8 + 14 = 22', '22']);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.equal(result.requests.length, 2);
  const [first, second] = result.receipts;
  assert.equal(result.receipts.length, 2);
  assert.ok(first && second);
  assert.equal(first.phase, 'initial');
  assert.equal(first.correctionRequested, true);
  const failed = first.checks.find(({ status }) => status === 'failed');
  assert.ok(failed);
  assert.ok(result.requests[1]?.includes(failed.detail));
  assert.equal(second.phase, 'recheck');
  assert.equal(second.correctionRequested, false);
  assert.ok(second.checks.length && second.checks.every(({ status }) => status === 'passed'));
});

test('real SDK repair publishes the missing file and verifies its immutable bytes', async () => {
  const result = await runScenario('请交付 report.md', [
    '文档已交付。',
    publish('toolu_publish_report', 'report.md', 'Verified artifact'),
    '已发布 report.md。',
  ]);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.equal(result.requests.length, 3);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.receipts.at(-1)?.checks[0]?.artifactId, result.artifacts[0]?.id);
  assert.equal(result.receipts.at(-1)?.checks[0]?.fingerprint, result.artifacts[0]?.fingerprint);
  assert.deepEqual(
    result.receipts.map(({ checks }) => checks.map(({ status }) => status)),
    [['failed'], ['passed']],
  );
});

test('real SDK surfaces a blocking question without trying to repair an unfinished delivery', async () => {
  const question = '两份订单表对 A102 的状态冲突。今天应发货，还是排除？';
  const result = await runScenario('合并订单并交付 report.md', [
    [
      {
        name: 'mcp__atelier__request_clarification',
        id: 'toolu_blocked_delivery',
        input: { question: `  ${question}  ` },
      },
    ],
    '收到答复后继续。',
  ]);
  assert.ok(
    result.requests[1]?.includes('recorded'),
    'the SDK must receive a successful question receipt',
  );
  assert.equal(result.requests.length, 2);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(result.artifacts, []);
  const requested = result.history.filter(({ type }) => type === 'run.clarification_requested');
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.payload.question, question);
  assert.equal(result.messages.filter((message) => message.text === question).length, 1);
});

test('a run cannot publish after it has asked for a blocking decision', async () => {
  const result = await runScenario('请交付 report.md', [
    [
      {
        name: 'mcp__atelier__request_clarification',
        id: 'toolu_pending_decision',
        input: { question: '应采用已取消的状态吗？' },
      },
    ],
    publish('toolu_premature_report', 'report.md', 'unresolved content'),
    '等待用户确认。',
  ]);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(result.receipts, []);
  assert.ok(result.requests[2]?.includes('先回答澄清问题'));
});

test('automatically approved edits are blocked while the question is unanswered', async () => {
  const result = await runScenario(
    '采用我确认的状态并交付 report.md',
    [
      [
        {
          name: 'mcp__atelier__request_clarification',
          id: 'toolu_which_status',
          input: { question: '用 A 还是 B？' },
        },
      ],
      [
        {
          name: 'mcp__atelier__write_file',
          id: 'toolu_unconfirmed_write',
          input: { path: 'guessed.txt', content: 'B', reason: 'Write the selected status' },
        },
      ],
      '等待确认。',
    ],
    true,
  );
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.deepEqual(result.projectFiles, []);
  assert.ok(result.requests[2]?.includes('先回答澄清问题'));
});

test('real SDK uses a newly inserted user request and ignores the superseded Stop', async () => {
  const result = await runScenario('只回复 22', [
    insertBeforeReply('只回复 33', '旧任务的答复'),
    '遗漏了新要求',
    '33',
  ]);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.equal(result.requests.length, 3);
  assert.ok(result.requests[1]?.includes('只回复 33'));
  assert.deepEqual(
    result.receipts.map(({ correctionRequested }) => correctionRequested),
    [true, false],
  );
});

test('real SDK user stop during correction preserves the user stop outcome', async () => {
  const result = await runScenario('只回复 22', [
    '已经完成',
    async (runner, run) => {
      runner.stop(run.id);
      return '仍然错误';
    },
  ]);
  assert.equal(result.requests.length, 2);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.run.status, 'stopped');
  assert.equal(result.run.error, null);
});

test('real SDK repeated false completion exhausts its single correction and the run fails', async () => {
  const result = await runScenario('只回复 22', ['已经完成', '仍然完成']);
  assert.equal(result.requests.length, 2);
  assert.deepEqual(
    result.receipts.map(({ correctionRequested }) => correctionRequested),
    [true, false],
  );
  assert.equal(result.run.status, 'failed');
  const failure = result.receipts.at(-1)?.checks.find(({ status }) => status === 'failed');
  assert.ok(failure);
  assert.ok(result.run.error?.includes(failure.detail));
});

test('real SDK accepts an exact first answer once and leaves unconstrained work on its original turn', async () => {
  const exact = await runScenario('只回复 22', ['22']);
  assert.equal(exact.run.status, 'completed', exact.run.error ?? undefined);
  assert.equal(exact.requests.length, 1);
  assert.equal(exact.receipts.length, 1);
  assert.equal(exact.receipts[0]?.checks[0]?.status, 'passed');
  const ordinary = await runScenario('解释什么是闭包', ['函数保留了对外层变量的访问。']);
  assert.equal(ordinary.run.status, 'completed', ordinary.run.error ?? undefined);
  assert.equal(ordinary.requests.length, 1);
  assert.deepEqual(ordinary.receipts, []);
});

test('a skipped main Stop verifies the final SDK answer; child, foreign and stale stops cannot spend the correction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-acceptance-stop-'));
  const store = new Store(join(directory, 'data'));
  try {
    const run = fixture(store, directory, '只回复 22', 'http://127.0.0.1:1');
    const sdkSessionId = randomUUID();
    const signal = new AbortController().signal;
    const acceptance = new RunAcceptanceStop(
      run,
      store,
      new FileRecords(store),
      signal,
      sdkSessionId,
    );
    const stop = acceptance.hooks.Stop[0]?.hooks[0];
    assert.ok(stop);
    const event = {
      hook_event_name: 'Stop' as const,
      session_id: sdkSessionId,
      cwd: directory,
      transcript_path: '',
      stop_hook_active: false,
      last_assistant_message: '已经完成',
    };
    const submit = acceptance.hooks.UserPromptSubmit[0]?.hooks[0];
    assert.ok(submit);
    await submit(
      { ...event, hook_event_name: 'UserPromptSubmit', prompt_id: 'previous', prompt: run.prompt },
      undefined,
      { signal },
    );
    assert.deepEqual(await stop({ ...event, agent_id: 'child' }, undefined, { signal }), {});
    assert.deepEqual(await stop({ ...event, session_id: randomUUID() }, undefined, { signal }), {});
    acceptance.replaceInput('只回复 33', randomUUID());
    assert.throws(
      () =>
        acceptance.requestClarification('旧问题？', 'previous', () =>
          assert.fail('stale question became visible'),
        ),
      { code: 'CLARIFICATION_STALE' },
    );
    assert.deepEqual(await stop({ ...event, prompt_id: 'previous' }, undefined, { signal }), {});
    assert.equal(store.runHistory(run.id).events.length, 0);
    const failure = await acceptance.finalFailure('22');
    assert.match(failure ?? '', /验收未通过/);
    const events = store.runHistory(run.id).events;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.correctionRequested, false);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a new reply-only input preserves files already delivered for the preceding request', async () => {
  const result = await runScenario('请交付 old.md', [
    publish('toolu_publish_old', 'old.md', 'Earlier delivery'),
    insertBeforeReply('只回复 33', '已交付 old.md'),
    '33',
  ]);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.equal(result.requests.length, 3);
  assert.equal(result.artifacts[0]?.name, 'old.md');
  assert.equal(result.receipts.length, 1);
  assert.equal(
    result.receipts[0]?.checks.find(({ criterion }) => criterion === 'reply_only')?.status,
    'passed',
  );
});

test('reply-only publication is rejected by the real tool before creating an artifact', async () => {
  const result = await runScenario('只回复 22', [
    publish('toolu_unwanted', 'unwanted.md', 'Unexpected file'),
    '22',
  ]);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.equal(result.requests.length, 2);
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]?.correctionRequested, false);
});

test('real SDK cannot spend a second repair after the user changes their request', async () => {
  const result = await runScenario('只回复 22', [
    '首次错误',
    insertBeforeReply('只回复 33', '旧答复'),
    '新答复仍错',
  ]);
  assert.equal(result.requests.length, 3);
  assert.equal(result.run.status, 'failed');
  assert.deepEqual(
    result.receipts.map(({ correctionRequested }) => correctionRequested),
    [true, false],
  );
});

test('an unreadable immutable artifact fails verification without another model request', async () => {
  const result = await runScenario('请交付 report.md', [
    publish('toolu_missing_bytes', 'report.md', 'Temporary test bytes'),
    async (_runner, run, store) => {
      const artifact = store.repos.artifacts.listByRun(run.id)[0];
      assert.ok(artifact);
      await rm(join(store.directory, 'artifacts', artifact.id));
      return '已完成。';
    },
  ]);
  assert.equal(result.requests.length, 2);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]?.correctionRequested, false);
  const observation = result.receipts[0]?.checks.find(({ status }) => status === 'unverified');
  assert.ok(observation);
  assert.ok(result.run.error?.includes(observation.detail));
});

test('continuing a run retains the accepted criteria; an explicit additional delivery is checked alongside the original', async () => {
  const continued = await runScenario('只回复 22', [
    insertBeforeReply('继续', '旧答复'),
    '已完成',
    '22',
  ]);
  assert.equal(continued.run.status, 'completed');
  assert.deepEqual(
    continued.receipts.map((r) => r.correctionRequested),
    [true, false],
  );
  const extra = await runScenario('交付 a.md', [
    insertBeforeReply('另外，交付 b.md', '旧答复'),
    '已完成',
    '已完成',
  ]);
  assert.equal(extra.run.status, 'failed');
  const missing = extra.receipts.at(-1)?.checks.filter((c) => c.status === 'failed');
  assert.equal(missing?.length, 2);
  assert.ok(missing?.some((c) => c.detail.includes('a.md')));
  assert.ok(missing?.some((c) => c.detail.includes('b.md')));
});

test('real SDK sends the missing passage back and accepts the corrected Markdown version', async () => {
  const result = await runScenario('交付 report.md。\nreport.md 必须包含「决议待核实」。', [
    publish('toolu_draft', 'report.md', '# 交接'),
    '决议待核实，已经交付。',
    publish('toolu_fixed', 'report.md', '# 交接\n决议待核实'),
    '已修正。',
  ]);
  assert.equal(result.run.status, 'completed', result.run.error ?? undefined);
  assert.equal(result.requests.length, 4);
  assert.deepEqual(
    result.receipts.map((r) => r.checks.find((c) => c.criterion === 'artifact_contains')?.status),
    ['failed', 'passed'],
  );
  assert.ok(result.requests[2]?.includes('缺少用户要求的原文「决议待核实」'));
  assert.equal(result.artifacts.length, 2);
});
