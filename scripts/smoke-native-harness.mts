/**
 * @file 通过隔离桌面和回环模型验收本机执行、停止与跨轮恢复。
 * @implementation 驱动真实 Electron 与 SDK，独立解析模型输入中的有界恢复检查点，核对跨轮约束、工具证据与无重放。
 * @updated 2026-11-22T20:00:00+08:00
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { z } from 'zod';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';

const directory = await mkdtemp(join(tmpdir(), 'atelier-native-smoke-'));
const project = join(directory, 'project');
const outside = join(directory, 'sibling.txt');
const childPid = join(project, 'test-process.pid');
const shellReceipt = join(project, 'shell-receipts.txt');
const model = 'native-desktop-fixture';
const earlyConstraint = 'EARLY_NATIVE_CONSTRAINT：禁止安装依赖，已完成的写入不得重复执行。';
const progressPrompt = '只汇报当前进度。';
const recentConstraint = 'RECENT_NATIVE_CONSTRAINT：只启动一次临时等待任务，停止后不要重放。';
const runSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  executor: z.literal('native-v1'),
  status: z.string(),
});
const snapshotSchema = z.object({
  session: z.object({ id: z.uuid(), sdkSessionId: z.string().nullable() }),
  runs: z.array(runSchema),
  tools: z.array(
    z.object({ id: z.string(), runId: z.uuid(), name: z.string(), status: z.string() }),
  ),
});
type Snapshot = z.infer<typeof snapshotSchema>;
let app: ElectronApplication | undefined;
let stage: 'files' | 'progress' | 'stop' | 'recover' = 'files';
let expectedCheckpointIds: string[] = [];
let stoppedToolId: string | undefined;
let checkpointChars = 0;
const counts = { files: 0, progress: 0, stop: 0, recover: 0 };
const errors: string[] = [];

function* stringValues(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) {
    for (const item of value) yield* stringValues(item);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) yield* stringValues(item);
  }
}

function hasUnverifiedEvidence(value: unknown, toolId: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const entries: unknown[] = Object.values(value);
  return (
    (!Array.isArray(value) &&
      entries.includes('unverified') &&
      [...stringValues(value)].includes(toolId)) ||
    entries.some((item) => hasUnverifiedEvidence(item, toolId))
  );
}

function checkpointFromInput(messages: readonly unknown[]) {
  const messageSchema = z.object({ role: z.string(), content: z.unknown() });
  const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
  const latestUserMessage = messages
    .map((message) => messageSchema.parse(message))
    .filter((message) => message.role === 'user')
    .at(-1);
  assert.ok(latestUserMessage, 'Recovery request has a current user input');
  // Only current user text blocks are eligible; prior conversation and tool outputs are not proof.
  const blocks =
    typeof latestUserMessage.content === 'string'
      ? [latestUserMessage.content]
      : z
          .array(z.unknown())
          .parse(latestUserMessage.content)
          .flatMap((block) => {
            const parsed = textBlockSchema.safeParse(block);
            return parsed.success ? [parsed.data.text] : [];
          });
  const checkpoints: { json: string; value: Record<string, unknown> }[] = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (!/^(?:会话)?恢复检查点(?:[（(].*[）)])?$/u.test(line.trim())) continue;
      const json = lines[index + 1];
      assert.ok(json, 'Checkpoint marker is followed immediately by one JSON line');
      assert.ok(json.length <= 32_768, 'Serialized recovery checkpoint has a bounded size');
      checkpoints.push({ json, value: z.record(z.string(), z.unknown()).parse(JSON.parse(json)) });
    }
  }
  assert.equal(
    checkpoints.length,
    1,
    'Current SDK input contains exactly one structured checkpoint',
  );
  const checkpoint = checkpoints[0];
  assert.ok(checkpoint);
  return checkpoint;
}

const gateway = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(req.url === '/routes' ? { data: [{ model }] } : {}));
  }
  try {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const data = z
      .object({ messages: z.array(z.unknown()), tools: z.array(z.object({ name: z.string() })) })
      .parse(JSON.parse(Buffer.concat(chunks).toString()));
    const text = JSON.stringify(data.messages);
    counts[stage]++;
    if (stage === 'recover') {
      const checkpoint = checkpointFromInput(data.messages);
      const values = [...stringValues(checkpoint.value)];
      assert.ok(
        expectedCheckpointIds.length > 0,
        'Persisted evidence was captured before reopening',
      );
      for (const expected of expectedCheckpointIds)
        assert.ok(
          values.includes(expected),
          `Structured checkpoint retains historical evidence ID: ${expected}`,
        );
      for (const expected of [earlyConstraint, progressPrompt, recentConstraint])
        assert.ok(
          values.some((value) => value.includes(expected)),
          `Structured checkpoint retains historical user constraint: ${expected}`,
        );
      assert.ok(stoppedToolId, 'Stopped Bash has a persisted tool ID');
      assert.ok(
        hasUnverifiedEvidence(checkpoint.value, stoppedToolId),
        'Stopped Bash evidence remains associated with an unverified side effect',
      );
      checkpointChars = checkpoint.json.length;
      return sendModelReply(res, model, '已从运行记录恢复。');
    }
    if (stage === 'progress') {
      assert.ok(text.includes(progressPrompt));
      return sendModelReply(res, model, '进度：文件修改已完成，未启动新操作。');
    }
    if (stage === 'stop' && counts.stop === 1)
      return sendModelReply(res, model, [
        {
          name: 'Bash',
          id: 'toolu_long',
          input: {
            command:
              'printf "started\\n" >> shell-receipts.txt; printf "%d" "$$" > test-process.pid; exec sleep 90',
            description: 'Wait for desktop cancellation',
            timeout: 120000,
          },
        },
      ]);
    if (stage === 'stop') return sendModelReply(res, model, '等待命令结果。');
    assert.ok(data.tools.some(({ name }) => name === 'Bash'));
    if (counts.files === 1)
      return sendModelReply(res, model, [
        { name: 'Read', id: 'toolu_read', input: { file_path: outside } },
      ]);
    if (counts.files === 2) {
      assert.ok(text.includes('BEFORE_NATIVE_FIXTURE'));
      return sendModelReply(res, model, [
        {
          name: 'Edit',
          id: 'toolu_edit',
          input: {
            file_path: outside,
            old_string: 'BEFORE_NATIVE_FIXTURE',
            new_string: 'AFTER_NATIVE_FIXTURE',
          },
        },
      ]);
    }
    return sendModelReply(res, model, '本机文件修改已完成。');
  } catch (error) {
    errors.push(String(error));
    res.writeHead(400).end(
      JSON.stringify({
        error: { type: 'invalid_request_error', message: 'Invalid fixture request' },
      }),
    );
  }
});

async function launch(port: number) {
  return electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      resolve('dist/desktop/main.mjs'),
      `--user-data-dir=${join(directory, 'profile')}`,
      '--disable-gpu',
    ],
    env: {
      ...process.env,
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_GATEWAY: `http://127.0.0.1:${port}`,
      ATELIER_GATEWAY_TOKEN: 'offline-native-fixture',
      ATELIER_MODEL: model,
      ATELIER_PORT: '0',
      ATELIER_MAGPIE_URL: '',
    },
    timeout: 25_000,
  });
}

async function send(page: Page, text: string) {
  await page.getByRole('button', { name: '发送任务', exact: true }).waitFor();
  const input = page.locator('#prompt-input');
  await input.fill(text);
  const [response] = await Promise.all([
    page.waitForResponse(
      (result) =>
        result.request().method() === 'POST' &&
        /^\/api\/sessions\/[^/]+\/messages$/u.test(new URL(result.url()).pathname),
    ),
    input.press('Enter'),
  ]);
  assert.equal(response.status(), 202, 'Composer starts a new native run');
  return z.object({ run: runSchema }).parse(await response.json()).run;
}

async function snapshot(page: Page, sessionId: string): Promise<Snapshot> {
  const response = await page.evaluate(async (id) => {
    const result = await fetch(`/api/sessions/${id}`, { signal: AbortSignal.timeout(5000) });
    return { status: result.status, body: (await result.json()) as unknown };
  }, sessionId);
  assert.equal(response.status, 200);
  return snapshotSchema.parse(response.body);
}

async function completed(page: Page, sessionId: string, answer: string): Promise<Snapshot> {
  await page.getByText(answer, { exact: true }).first().waitFor({ timeout: 18_000 });
  await page.getByRole('button', { name: '发送任务', exact: true }).waitFor();
  assert.deepEqual(errors, [], 'Loopback gateway accepted SDK requests');
  return snapshot(page, sessionId);
}

try {
  await mkdir(project);
  await writeFile(outside, 'BEFORE_NATIVE_FIXTURE\n');
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  app = await launch(address.port);
  let page = await app.firstWindow();
  page.setDefaultTimeout(18_000);
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(project);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  await page
    .getByRole('combobox', { name: '运行模式' })
    .getByText('本机信任', { exact: true })
    .waitFor();
  const filesRun = await send(page, `${earlyConstraint}\n验证本机文件操作。`);
  const files = await completed(page, filesRun.sessionId, '本机文件修改已完成。');
  assert.equal(files.runs.find(({ id }) => id === filesRun.id)?.status, 'completed');
  assert.equal(await readFile(outside, 'utf8'), 'AFTER_NATIVE_FIXTURE\n');
  const earlyTools = files.tools.filter(({ runId }) => runId === filesRun.id);
  assert.deepEqual(earlyTools.map(({ name }) => name).sort(), ['Edit', 'Read']);
  assert.ok(earlyTools.every(({ status }) => status === 'succeeded'));
  const hash = new URL(page.url()).hash;

  stage = 'progress';
  const progressRun = await send(page, progressPrompt);
  assert.equal(progressRun.sessionId, filesRun.sessionId);
  const progress = await completed(
    page,
    filesRun.sessionId,
    '进度：文件修改已完成，未启动新操作。',
  );
  assert.equal(progress.runs.find(({ id }) => id === progressRun.id)?.status, 'completed');
  assert.deepEqual(progress.tools, files.tools, 'Progress question does not replay earlier tools');

  stage = 'stop';
  const stopRun = await send(page, `${recentConstraint}\n启动可停止的临时等待任务。`);
  assert.equal(stopRun.sessionId, filesRun.sessionId);
  const deadline = Date.now() + 18_000;
  let pid = 0;
  while (!pid && Date.now() < deadline) {
    pid = Number(await readFile(childPid, 'utf8').catch(() => ''));
    if (!pid) await delay(50);
  }
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Real Bash command started');
  assert.equal(await readFile(shellReceipt, 'utf8'), 'started\n');
  await page.locator('.composer-stop').click();
  await page.getByRole('button', { name: '发送任务', exact: true }).waitFor();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const stopped = await snapshot(page, filesRun.sessionId);
  assert.equal(stopped.runs.find(({ id }) => id === stopRun.id)?.status, 'stopped');
  const stoppedTools = stopped.tools.filter(({ runId }) => runId === stopRun.id);
  assert.equal(stoppedTools.length, 1, 'Stop run records exactly one real command');
  const stoppedTool = stoppedTools[0];
  assert.ok(stoppedTool);
  assert.equal(stoppedTool.name, 'Bash');
  assert.equal(stoppedTool.status, 'canceled');
  stoppedToolId = stoppedTool.id;
  expectedCheckpointIds = [
    filesRun.sessionId,
    filesRun.id,
    ...earlyTools.map(({ id }) => id),
    progressRun.id,
    stopRun.id,
    stoppedTool.id,
  ];
  await app.close();
  app = undefined;

  stage = 'recover';
  app = await launch(address.port);
  page = await app.firstWindow();
  page.setDefaultTimeout(18_000);
  await page.waitForURL((url) => url.hash === hash);
  const reopened = await snapshot(page, filesRun.sessionId);
  assert.deepEqual(
    reopened.tools,
    stopped.tools,
    'Reopening preserves tool evidence without replay',
  );
  const recoveryRun = await send(page, '总结各轮已发生的工作，只汇报，不执行工具。');
  assert.equal(recoveryRun.sessionId, filesRun.sessionId);
  const recovered = await completed(page, filesRun.sessionId, '已从运行记录恢复。');
  assert.equal(recovered.runs.find(({ id }) => id === recoveryRun.id)?.status, 'completed');
  assert.ok(recovered.session.sdkSessionId, 'Recovery creates a real SDK session');
  assert.notEqual(
    recovered.session.sdkSessionId,
    stopped.session.sdkSessionId,
    'Stop and reopen force a new SDK context',
  );
  assert.equal(
    new Set(recovered.runs.map(({ id }) => id)).size,
    4,
    'Four distinct user runs persisted',
  );
  assert.deepEqual(
    recovered.tools,
    stopped.tools,
    'Recovery does not replay historical tool calls',
  );
  assert.equal(await readFile(outside, 'utf8'), 'AFTER_NATIVE_FIXTURE\n');
  assert.equal(
    await readFile(shellReceipt, 'utf8'),
    'started\n',
    'Stopped command was not restarted',
  );
  assert.equal(
    Number(await readFile(childPid, 'utf8')),
    pid,
    'Recovery leaves the original PID receipt',
  );
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(checkpointChars > 0, 'Loopback model independently parsed the recovery checkpoint');
  assert.deepEqual(counts, { files: 3, progress: 1, stop: 1, recover: 1 });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: 'passed',
      modelTransport: 'loopback',
      nativeFileChanged: true,
      commandStopped: true,
      checkpointRestored: true,
      historicalConstraintsRestored: true,
      historicalToolEvidenceRestored: true,
      unverifiedSideEffectRestored: true,
      sdkContextRebuilt: true,
      toolsReplayed: false,
      checkpointChars,
      counts,
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ result: 'failed', stage, counts, errors }));
  throw error;
} finally {
  await app?.close();
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
