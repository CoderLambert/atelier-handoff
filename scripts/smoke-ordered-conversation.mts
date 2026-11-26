/**
 * @file 在隔离真实 Electron 窗口验收按顺序显示的会话。
 * @implementation 用本地回环模型驱动真实 SDK、反向完成工具与连续文本，并核对双语、焦点及重开。
 * @updated 2026-11-26T10:30:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { Store } from '../server/store.js';

type Block = { text: string } | { id: string; command: string };
function reply(response: ServerResponse, model: string, blocks: Block[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': randomUUID() });
  const usage = {
    input_tokens: 12,
    output_tokens: blocks.length,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const send = (type: string, values: object = {}) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`);
  send('message_start', {
    message: {
      id: 'msg_' + randomUUID(),
      role: 'assistant',
      type: 'message',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...usage, output_tokens: 0 },
    },
  });
  blocks.forEach((block, index) => {
    if ('text' in block) {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      // More than one delta proves the stable part is updated rather than duplicated.
      const middle = Math.max(1, Math.floor(block.text.length / 2));
      for (const text of [block.text.slice(0, middle), block.text.slice(middle)])
        send('content_block_delta', { index, delta: { type: 'text_delta', text } });
    } else {
      send('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: block.id, name: 'Bash', input: {} },
      });
      send('content_block_delta', {
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({
            command: block.command,
            description: 'Transcript order fixture',
            timeout: 30_000,
          }),
        },
      });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', {
    delta: {
      stop_reason: blocks.some((block) => 'command' in block) ? 'tool_use' : 'end_turn',
      stop_sequence: null,
    },
    usage,
  });
  send('message_stop');
  response.end();
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out observing ' + label)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const evidence = resolve(
  process.env.ATELIER_TRANSCRIPT_EVIDENCE_DIR ?? '.local/ordered-conversation',
);
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'atelier-ordered-ui-'));
const project = join(directory, 'project');
await mkdir(project);
await writeFile(join(project, 'synthetic-log.txt'), 'synthetic-log-line\n'.repeat(10000));
const model = 'fixture-ordered-ui';
let calls = 0;
const gateway = createServer(async (request, response) => {
  if (request.method !== 'POST')
    return response.end(JSON.stringify({ data: [{ model, id: model }] }));
  for await (const _chunk of request) {
    /* Drain the real SDK request. */
  }
  if (++calls === 1)
    return reply(response, model, [
      { text: 'TRANSCRIPT_INTRO 😀' },
      {
        id: 'toolu_ui_first',
        command:
          "printf 'FIRST_START\\n'; while ! test -f release-first; do sleep 0.05; done; printf 'FIRST_END\\n'; cat synthetic-log.txt",
      },
      { text: 'TRANSCRIPT_BETWEEN' },
      {
        id: 'toolu_ui_second',
        command:
          "printf 'SECOND_START\\n'; while ! test -f release-second; do sleep 0.05; done; printf 'SECOND_END\\n'",
      },
    ]);
  reply(
    response,
    model,
    Array.from({ length: 505 }, (_, index) => ({
      text: `TRANSCRIPT_FINAL_${String(index).padStart(3, '0')}`,
    })),
  );
});
let app: ElectronApplication | undefined;
try {
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  async function launch() {
    return electron.launch({
      executablePath: resolve('node_modules/electron/dist/electron'),
      args: [
        resolve('dist/desktop/main.mjs'),
        `--user-data-dir=${join(directory, 'profile')}`,
        '--disable-gpu',
      ],
      env: {
        ...process.env,
        ATELIER_DATA_DIR: join(directory, 'data'),
        ATELIER_GATEWAY: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
        ATELIER_GATEWAY_TOKEN: 'ordered-ui-loopback',
        ATELIER_MODEL: model,
        ATELIER_PORT: '0',
        ATELIER_NATIVE_EXECUTION: '1',
        ATELIER_MAGPIE_URL: '',
      },
    });
  }
  app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(project);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  await page.locator('#prompt-input').fill('ORDER_UI_FIXTURE');
  await page.locator('#prompt-input').press('Enter');
  const first = page.locator('details[data-tool-id$="toolu_ui_first"]');
  const second = page.locator('details[data-tool-id$="toolu_ui_second"]');
  await first.locator(':scope > summary').waitFor();
  await second.locator(':scope > summary').waitFor();
  console.log('stage: two native tools running');
  const initial = await page.locator('[data-transcript-kind]').evaluateAll((elements) =>
    elements.map((element) => ({
      kind: element.getAttribute('data-transcript-kind'),
      order: element.getAttribute('data-transcript-order'),
      text: element.textContent ?? '',
    })),
  );
  const ordered = initial.filter((item) => ['user', 'text', 'tool'].includes(item.kind ?? ''));
  assert.deepEqual(
    ordered.map((item) => item.kind),
    ['user', 'text', 'tool', 'text', 'tool'],
  );
  assert.ok(ordered[1]?.text.includes('TRANSCRIPT_INTRO 😀'));
  assert.ok(ordered[3]?.text.includes('TRANSCRIPT_BETWEEN'));
  assert.ok(
    ordered.every(
      (item, index) => index === 0 || Number(ordered[index - 1]?.order) < Number(item.order),
    ),
  );
  await first.locator(':scope > summary').press('Enter');
  assert.equal(await first.evaluate((element) => element.hasAttribute('open')), true);
  assert.ok((await first.innerText()).includes('release-first'));
  // Keep a real command active beyond the heartbeat interval to observe elapsed updates.
  const statusBefore = await page.locator('[data-run-elapsed]').textContent();
  await page.waitForTimeout(16_000);
  const statusAfter = await page.locator('[data-run-elapsed]').textContent();
  assert.notEqual(statusAfter, statusBefore, 'elapsed time advances while a native tool waits');
  await writeFile(
    join(evidence, 'elapsed-status.json'),
    JSON.stringify({ before: statusBefore, after: statusAfter }, null, 2),
  );
  await page.screenshot({ path: join(evidence, 'running-zh.png') });
  let eventSourceAttempts = 0;
  let firstEventSourceAttempt = () => {};
  let recoveredEventSource = () => {};
  const eventSourceAborted = new Promise<void>((done) => {
    firstEventSourceAttempt = done;
  });
  const eventSourceRecovered = new Promise<void>((done) => {
    recoveredEventSource = done;
  });
  await page.route('**/api/events?*', async (route) => {
    eventSourceAttempts++;
    if (eventSourceAttempts === 1) {
      await route.abort('connectionreset');
      firstEventSourceAttempt();
    } else {
      await route.continue();
      recoveredEventSource();
    }
  });
  console.log('stage: reloading with first EventSource attempt aborted');
  await page.reload();
  await within(eventSourceAborted, 'first EventSource abort');
  await second.locator('.tool-detail__status[data-status="running"]').waitFor();
  await first.locator(':scope > summary').click();
  await writeFile(join(project, 'release-second'), '');
  await within(eventSourceRecovered, 'EventSource automatic retry');
  await second.locator('.tool-detail__status[data-status="succeeded"]').waitFor();
  assert.ok(eventSourceAttempts >= 2);
  console.log('stage: EventSource retried and replayed tool completion');
  await page.unroute('**/api/events?*');
  assert.equal(await first.evaluate((element) => element.hasAttribute('open')), true);
  await writeFile(join(project, 'release-first'), '');
  await page.getByText('TRANSCRIPT_FINAL_504', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-transcript-kind="text"]').count(), 507);
  assert.equal(await page.getByText('TRANSCRIPT_INTRO 😀', { exact: true }).count(), 1);
  assert.equal(await page.getByText('TRANSCRIPT_BETWEEN', { exact: true }).count(), 1);
  assert.equal(await first.evaluate((element) => element.hasAttribute('open')), true);
  console.log('stage: all 507 text parts rendered');
  const toolOrders = await page
    .locator('[data-transcript-kind="tool"]')
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-transcript-order')),
    );
  assert.deepEqual(
    toolOrders,
    ordered.filter((item) => item.kind === 'tool').map((item) => item.order),
  );
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height),
      { width, height },
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
  }
  const sessionHash = new URL(page.url()).hash;
  await page.reload();
  await page.getByText('TRANSCRIPT_FINAL_504', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-transcript-kind="text"]').count(), 507);
  await page.goto(new URL('/#/settings/models', page.url()).href);
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.goto(new URL('/' + sessionHash, page.url()).href);
  await page.getByText('TRANSCRIPT_FINAL_504', { exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.screenshot({ path: join(evidence, 'completed-en.png') });
  if (!(await first.evaluate((element) => element.hasAttribute('open'))))
    await first.locator(':scope > summary').click();
  await first.getByRole('button', { name: 'View full log', exact: true }).click();
  const log = page.getByRole('dialog', { name: 'Full Bash log' });
  await log.getByText(/FIRST_END/).waitFor();
  await page.keyboard.press('Escape');
  await log.waitFor({ state: 'hidden' });
  assert.equal(
    await first
      .getByRole('button', { name: 'View full log', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  console.log('stage: full log dialog focus restored');
  await app.close();
  app = undefined;
  // Add a pre-feature persisted run only after the isolated runtime has released its writer.
  const legacyStore = new Store(join(directory, 'data'));
  try {
    const source = legacyStore.list('runs')[0];
    assert.ok(source);
    const { transcript: _transcript, ...runData } = source;
    const at = new Date(Date.parse(source.createdAt) - 60_000).toISOString();
    const legacyRun = legacyStore.put('runs', {
      ...runData,
      id: 'legacy_transcript_fixture',
      prompt: 'LEGACY_USER_BODY',
      createdAt: at,
      startedAt: at,
      endedAt: at,
    });
    legacyStore.put('messages', {
      id: 'legacy_user_fixture',
      runId: legacyRun.id,
      sessionId: source.sessionId,
      role: 'user',
      text: 'LEGACY_USER_BODY',
      createdAt: at,
    });
    legacyStore.put('messages', {
      id: 'legacy_assistant_fixture',
      runId: legacyRun.id,
      sessionId: source.sessionId,
      role: 'assistant',
      text: 'LEGACY_ASSISTANT_BODY',
      createdAt: at,
    });
    legacyStore.put('tools', {
      id: 'legacy_tool_fixture',
      runId: legacyRun.id,
      sessionId: source.sessionId,
      name: 'Read',
      inputSummary: 'legacy.txt',
      status: 'succeeded',
      output: 'LEGACY_TOOL_RECEIPT',
      startedAt: at,
      endedAt: at,
    });
    legacyStore.event(legacyRun.id, source.sessionId, 'tool.finished', {
      toolCallId: 'legacy_tool_fixture',
    });
  } finally {
    legacyStore.close();
  }
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.goto(new URL('/' + sessionHash, page.url()).href);
  await page.getByText('TRANSCRIPT_FINAL_504', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-transcript-kind="text"]').count(), 507);
  await page.getByText('LEGACY_USER_BODY', { exact: true }).waitFor();
  await page.getByText('LEGACY_ASSISTANT_BODY', { exact: true }).waitFor();
  const legacy = page.locator('[data-run-id="legacy_transcript_fixture"]');
  assert.equal(
    await legacy.locator('[data-transcript-kind]').count(),
    0,
    'legacy run keeps its original overview',
  );
  await page.locator('[data-message-id="legacy_assistant_fixture"] .run-history-toggle').click();
  const legacyTool = page.locator('details[data-tool-id="legacy_tool_fixture"]');
  await legacyTool.locator(':scope > summary').waitFor();
  if (!(await legacyTool.evaluate((element) => element.hasAttribute('open'))))
    await legacyTool.locator(':scope > summary').click();
  await legacyTool.getByText('LEGACY_TOOL_RECEIPT', { exact: true }).waitFor();
  await page.getByRole('tab', { name: /^Activity/ }).click();
  await page.locator('#inspector-trace-run').click();
  await page.getByRole('option', { name: /LEGACY_USER_BODY/ }).click();
  const legacyEvent = page
    .locator('details[data-event-type="tool.finished"]')
    .filter({ hasText: 'legacy.txt' });
  await legacyEvent.locator(':scope > summary').click();
  await legacyEvent.getByText('LEGACY_TOOL_RECEIPT', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Conversation', exact: true }).click();
  await page.getByText('TRANSCRIPT_FINAL_504', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'mixed-legacy-and-ordered-en.png') });
  console.log('stage: mixed legacy/new conversation and legacy trace verified');
  const result = {
    result: 'passed',
    sdk: 'real locked Claude SDK',
    modelTransport: 'isolated loopback',
    realElectron: true,
    orderedInitialKinds: ordered.map((item) => item.kind),
    textParts: 507,
    reverseCompletion: true,
    stableToolPositions: true,
    duplicateAssistantText: false,
    reloaded: true,
    eventSourceAbortedAndRetried: true,
    restarted: true,
    mixedLegacyAndOrderedRuns: true,
    legacyTrace: true,
    englishAndChinese: true,
    widths: [1280, 1440, 1920],
    keyboardExpansion: true,
    logFocusRestored: true,
    calls,
  };
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await app?.close();
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
