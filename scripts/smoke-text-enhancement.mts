/**
 * @file 在隔离 Linux Electron 中验收聊天增强提示词。
 * @implementation 使用临时 SQLite 和 profile、实际 SDK 首发与回环模型，检查双语键盘、取消和持久化边界。
 * @updated 2026-11-28T18:00:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { _electron, type ElectronApplication } from 'playwright-core';
import { z } from 'zod';
import { composerTextLimit } from '../shared/message-quotes.js';

const directory = await mkdtemp(join(tmpdir(), 'atelier-enhancement-smoke-'));
let app: ElectronApplication | undefined;
let modelMode: 'success' | 'invalid' | 'hold' = 'success';
const modelRequests: Array<{ draft: string; result: string }> = [];
const upstream = new EventEmitter();
const messageRequest = z.object({
  system: z.unknown(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  stream: z.boolean().optional(),
});
const gateway = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ model: 'fixture', id: 'fixture' }] }));
    return;
  }
  request.setEncoding('utf8');
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  const parsed = messageRequest.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    response.writeHead(400).end();
    return;
  }
  if (!parsed.data.stream) {
    const body = z
      .strictObject({
        model: z.literal('fixture'),
        max_tokens: z.number(),
        system: z.string().includes('read-only'),
        messages: z.tuple([z.strictObject({ role: z.literal('user'), content: z.string() })]),
      })
      .safeParse(JSON.parse(raw));
    if (!body.success) {
      response.writeHead(400).end();
      return;
    }
    const draft = body.data.messages[0].content;
    const result =
      draft === 'Check the send limit'
        ? 'x'.repeat(composerTextLimit)
        : /[\u4e00-\u9fff]/u.test(draft)
          ? draft + '，然后汇报检查结果。'
          : draft + ' and summarize the findings.';
    modelRequests.push({ draft, result });
    if (modelMode === 'hold') {
      response.once('close', () => upstream.emit('closed'));
      upstream.emit('held');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        stop_reason: modelMode === 'invalid' ? 'max_tokens' : 'end_turn',
        content: [{ type: 'text', text: result }],
      }),
    );
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': randomUUID() });
  const usage = { input_tokens: 10, output_tokens: 1 };
  const event = (type: string, fields: object = {}) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event('message_start', {
    message: {
      id: 'msg_' + randomUUID(),
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Fixture reply' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
  event('message_stop');
  response.end();
});

async function expectSignal(signal: Promise<unknown>, message: string) {
  await Promise.race([
    signal,
    delay(5000, undefined, { ref: false }).then(() => assert.fail(message)),
  ]);
}

try {
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const project = join(directory, 'Enhancement project');
  const data = join(directory, 'data');
  await mkdir(project);
  app = await _electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      resolve('dist/desktop/main.mjs'),
      `--user-data-dir=${join(directory, 'profile')}`,
      '--disable-gpu',
      ...(process.env.WAYLAND_DISPLAY ? ['--ozone-platform=wayland'] : []),
    ],
    env: {
      ...process.env,
      ATELIER_DATA_DIR: data,
      ATELIER_PORT: '0',
      ATELIER_GATEWAY: `http://127.0.0.1:${address.port}`,
      ATELIER_GATEWAY_TOKEN: 'enhancement-loopback',
      ATELIER_MAGPIE_URL: '',
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_MODEL: 'fixture',
    },
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
  const page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  const input = page.locator('#prompt-input');
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(project);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });

  function counts() {
    const database = new Database(join(data, 'atelier.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      return ['sessions', 'messages', 'runs', 'pending_messages'].map(
        (table) =>
          z
            .object({ total: z.number() })
            .parse(database.prepare(`SELECT count(*) AS total FROM ${table}`).get()).total,
      );
    } finally {
      database.close();
    }
  }

  const original = '先只读检查 ./sample，保留 `pwd`';
  await input.fill(original);
  await page.locator('form.composer input[type=file]').setInputFiles({
    name: 'private-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('ATTACHMENT_NOT_FOR_ENHANCEMENT'),
  });
  await page.getByText('private-note.txt', { exact: true }).waitFor();
  const enhance = page.getByRole('button', { name: '增强提示词', exact: true });
  const undo = page.getByRole('button', { name: '撤销增强', exact: true });
  await enhance.press('Enter');
  await undo.waitFor();
  assert.deepEqual(modelRequests[0], { draft: original, result: await input.inputValue() });
  assert.notEqual(await input.inputValue(), original);
  assert.deepEqual(counts(), [0, 0, 0, 0]);
  await undo.press('Space');
  assert.equal(await input.inputValue(), original);
  assert.deepEqual(counts(), [0, 0, 0, 0]);

  modelMode = 'invalid';
  await enhance.press('Space');
  await page.getByText('模型返回的增强内容无效、不完整或过长。请重试。', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), original);
  assert.deepEqual(counts(), [0, 0, 0, 0]);

  modelMode = 'hold';
  const heldZh = once(upstream, 'held');
  const closedZh = once(upstream, 'closed');
  const started = page.waitForRequest('**/api/text-enhancements');
  await enhance.press('Enter');
  await started;
  const cancel = page.getByRole('button', { name: '取消增强', exact: true });
  await cancel.waitFor();
  await expectSignal(heldZh, 'Chinese request did not reach the gateway');
  await cancel.press('Space');
  await expectSignal(closedZh, 'The gateway request survived cancellation');
  assert.equal(await input.inputValue(), original);
  assert.deepEqual(counts(), [0, 0, 0, 0]);

  modelMode = 'success';
  await enhance.press('Enter');
  await undo.waitFor();
  const sentText = await input.inputValue();
  modelMode = 'hold';
  const heldWhileSending = once(upstream, 'held');
  const closedWhileSending = once(upstream, 'closed');
  await enhance.press('Space');
  await expectSignal(heldWhileSending, 'The enhancement did not reach the gateway before sending');
  assert.deepEqual(counts(), [0, 0, 0, 0]);
  const officialSend = page.waitForResponse(
    (reply) =>
      reply.request().method() === 'POST' && /\/api\/sessions\/[^/]+\/messages$/u.test(reply.url()),
  );
  await input.press('Enter');
  await expectSignal(closedWhileSending, 'First send did not cancel the in-flight enhancement');
  modelMode = 'success';
  assert.equal((await officialSend).status(), 202);
  await page.waitForURL('**/#/sessions/*');
  const sessionUrl = page.url();
  await page.getByText('Fixture reply', { exact: true }).waitFor();
  const sessionId = sessionUrl.split('/').at(-1);
  const { messages } = z
    .object({
      messages: z.array(z.object({ role: z.string(), text: z.string() })),
    })
    .parse(
      await page.evaluate(async (id) => (await fetch('/api/sessions/' + id)).json(), sessionId),
    );
  assert.deepEqual(
    messages.filter(({ role }) => role === 'user').map(({ text }) => text),
    [sentText],
  );
  console.log(
    'Chinese 1440×900: keyboard enhancement, undo, failure, cancellation, and first send while enhancing',
  );

  await page.goto(new URL('/#/settings/models', page.url()).href);
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  await page.goto(sessionUrl);
  await page.getByRole('button', { name: 'Quote reply', exact: true }).click();
  const quotes = page.getByRole('list', { name: 'Quoted replies', exact: true });
  await quotes.getByText('Fixture reply', { exact: true }).waitFor();
  await input.fill('Read ./sample in read-only mode');
  const baseline = counts();
  const enhanceEn = page.getByRole('button', { name: 'Enhance prompt', exact: true });
  const undoEn = page.getByRole('button', { name: 'Undo enhancement', exact: true });
  await enhanceEn.press('Space');
  await undoEn.waitFor();
  assert.equal(
    await input.inputValue(),
    'Read ./sample in read-only mode and summarize the findings.',
  );
  await undoEn.press('Enter');
  assert.equal(await input.inputValue(), 'Read ./sample in read-only mode');

  modelMode = 'invalid';
  await enhanceEn.press('Space');
  await page
    .getByText('The enhanced prompt was invalid, incomplete, or too long. Try again.', {
      exact: true,
    })
    .waitFor();
  assert.equal(await input.inputValue(), 'Read ./sample in read-only mode');
  assert.deepEqual(counts(), baseline);

  modelMode = 'hold';
  const heldEn = once(upstream, 'held');
  const closedEn = once(upstream, 'closed');
  const received = page.waitForRequest('**/api/text-enhancements');
  await enhanceEn.press('Enter');
  await received;
  await page.waitForFunction(() => document.body.textContent?.includes('Cancel enhancement'));
  await expectSignal(heldEn, 'English request did not reach the gateway');
  await input.fill('Edited while waiting');
  await expectSignal(closedEn, 'The gateway request survived the edit');
  await enhanceEn.waitFor();
  assert.equal(await input.inputValue(), 'Edited while waiting');
  assert.deepEqual(counts(), baseline);
  modelMode = 'success';
  await input.fill('Check the send limit');
  await enhanceEn.press('Space');
  await undoEn.waitFor();
  assert.equal((await input.inputValue()).length, composerTextLimit);
  const send = page.getByRole('button', { name: 'Send task', exact: true });
  assert.equal(await send.isDisabled(), true);
  await page
    .getByText(
      'The text and quotes exceed the input limit. Shorten the text or remove a quote to send.',
      { exact: true },
    )
    .waitFor();
  await undoEn.press('Enter');
  assert.equal(await input.inputValue(), 'Check the send limit');
  assert.equal(await send.isEnabled(), true);
  await quotes.getByText('Fixture reply', { exact: true }).waitFor();
  assert.deepEqual(counts(), baseline);
  console.log(
    'English 1280×800: saved session, keyboard enhancement, undo, failure, edit protection, and combined quote limit',
  );
} finally {
  gateway.closeAllConnections();
  if (app) {
    const shutdown = setTimeout(() => app?.process().kill('SIGKILL'), 10_000);
    try {
      await app.close();
    } finally {
      clearTimeout(shutdown);
    }
  }
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
