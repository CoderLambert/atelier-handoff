/**
 * @file 在隔离 Electron 中验收新会话草稿。
 * @implementation 通过真实运行时核对连续点击、项目切换、首发、附件和回执丢失后的重试。
 * @updated 2026-11-28T15:45:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication } from 'playwright-core';
import { z } from 'zod';

const directory = await mkdtemp(join(tmpdir(), 'atelier-new-conversation-'));
let app: ElectronApplication | undefined;
const gateway = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ model: 'fixture', id: 'fixture' }] }));
    return;
  }
  for await (const _chunk of request) {
    /* Drain the SDK request. */
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

try {
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const first = join(directory, 'First project');
  const second = join(directory, 'Second project');
  await Promise.all([mkdir(first), mkdir(second)]);
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
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_PORT: '0',
      ATELIER_GATEWAY: `http://127.0.0.1:${address.port}`,
      ATELIER_GATEWAY_TOKEN: 'new-conversation-loopback',
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
  await bind.getByLabel('本机目录').fill(first);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  await input.waitFor();

  const bootstrapSchema = z.object({
    csrfToken: z.string(),
    projects: z.array(z.object({ id: z.uuid(), path: z.string() })),
    sessions: z.array(z.object({ id: z.uuid() })),
  });
  const bootstrap = async () =>
    bootstrapSchema.parse(await page.evaluate(async () => (await fetch('/api/bootstrap')).json()));
  const newButton = page.getByRole('button', { name: '新建会话', exact: true });
  const clickRepeatedly = () =>
    newButton.evaluate((button: HTMLButtonElement) => {
      for (let i = 0; i < 4; i++) button.click();
    });
  await input.fill('项目一首条消息');
  await clickRepeatedly();
  assert.equal(await input.inputValue(), '项目一首条消息');
  assert.equal((await bootstrap()).sessions.length, 0, 'draft clicks do not persist a session');

  const { csrfToken, projects } = await bootstrap();
  const project1 = projects.find(({ path }) => path === first);
  assert.ok(project1);
  const other = await page.evaluate(
    async ({ path, csrfToken }) => {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
        body: JSON.stringify({ path }),
      });
      return response.json();
    },
    { path: second, csrfToken },
  );
  const project2 = z.object({ project: z.object({ id: z.uuid() }) }).parse(other).project;
  await page.getByRole('button', { name: '在「Second project」中新建会话' }).click();
  await page.waitForURL(`**/#/drafts/${project2.id}`);
  assert.equal(await input.inputValue(), '');
  await input.fill('Second project draft');
  await page.getByRole('button', { name: '在「First project」中新建会话' }).click();
  await page.waitForURL(`**/#/drafts/${project1.id}`);
  assert.equal(await input.inputValue(), '项目一首条消息');
  await page.reload();
  assert.equal(await input.inputValue(), '项目一首条消息');
  await page.locator('form.composer input[type=file]').setInputFiles({
    name: 'local-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('draft attachment'),
  });
  await page.getByText('local-note.txt', { exact: true }).waitFor();
  await page.getByRole('button', { name: '模型与推理深度', exact: true }).click();
  await page.getByRole('combobox', { name: '选择模型', exact: true }).click();
  await page.getByRole('option', { name: '手动输入 ID…', exact: true }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill('fixture-chosen');
  await page.getByRole('button', { name: '使用此模型', exact: true }).click();
  assert.equal((await bootstrap()).sessions.length, 0);

  console.log('Passed: draft reuse, project isolation, refresh, and staging');
  let createRequests = 0;
  let messageRequests = 0;
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path === '/api/sessions') createRequests++;
    if (/^\/api\/sessions\/[^/]+\/messages$/u.test(path)) messageRequests++;
  });
  // Let requests reach the paired runtime before simulating a lost response.
  await page.evaluate(() => {
    const request = window.fetch.bind(window);
    const lost = new Set<string>();
    window.fetch = async (input, init) => {
      const response = await request(input, init);
      const path = new URL(response.url).pathname;
      if (
        init?.method === 'POST' &&
        response.ok &&
        !lost.has(path) &&
        (path === '/api/sessions' || /^\/api\/sessions\/[^/]+\/messages$/u.test(path))
      ) {
        lost.add(path);
        await response.text();
        throw new TypeError('Fixture dropped response');
      }
      return response;
    };
  });

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/sessions',
  );
  await input.press('Enter');
  assert.equal((await created).status(), 201);
  console.log('Observed first create response');
  await page.waitForFunction(
    () => !document.querySelector<HTMLTextAreaElement>('#prompt-input')?.readOnly,
  );
  assert.equal(await input.inputValue(), '项目一首条消息');
  const { sessions } = await bootstrap();
  assert.equal(sessions.length, 1);
  const firstSessionId = sessions[0]?.id;
  assert.ok(firstSessionId);
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/api/sessions/${firstSessionId}/messages`),
  );
  await input.press('Enter');
  assert.equal((await submitted).status(), 202);
  console.log('Observed first message response');
  await page.waitForFunction(
    () => !document.querySelector<HTMLTextAreaElement>('#prompt-input')?.readOnly,
  );
  assert.equal(await input.inputValue(), '项目一首条消息');
  assert.equal(messageRequests, 1);
  await input.press('Enter');
  await page.waitForURL(`**/#/sessions/${firstSessionId}`);
  await page.waitForFunction(async (id) => {
    const response = await fetch('/api/sessions/' + id);
    return response.ok && (await response.json()).session.draft.model === 'fixture-chosen';
  }, firstSessionId);
  const data = await page.evaluate(
    async (id) => (await fetch('/api/sessions/' + id)).json(),
    firstSessionId,
  );
  const snapshot = z
    .object({
      messages: z.array(z.object({ role: z.string(), text: z.string() })),
      attachments: z.array(z.object({ name: z.string() })),
    })
    .parse(data);
  assert.equal(snapshot.messages.filter(({ role }) => role === 'user').length, 1);
  assert.equal(snapshot.messages.find(({ role }) => role === 'user')?.text, '项目一首条消息');
  assert.deepEqual(
    snapshot.attachments.map(({ name }) => name),
    ['local-note.txt'],
  );
  assert.deepEqual(
    (await bootstrap()).sessions.map(({ id }) => id),
    [firstSessionId],
  );
  assert.equal(createRequests, 3);
  assert.equal(messageRequests, 2);
  await page.getByText('Fixture reply', { exact: true }).waitFor();
  console.log('Passed: response-loss retries and a single accepted message with its attachment');

  await page.goto(new URL('/#/settings/models', page.url()).href);
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  await page.getByRole('button', { name: 'New session in “Second project”', exact: true }).click();
  await page.waitForURL(`**/#/drafts/${project2.id}`);
  assert.equal(await input.inputValue(), 'Second project draft');
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  assert.equal(await input.inputValue(), 'Second project draft');
  await page.getByRole('button', { name: 'New session in “First project”', exact: true }).click();
  await page.waitForURL(`**/#/drafts/${project1.id}`);
  assert.equal(await input.inputValue(), '');
  assert.equal((await bootstrap()).sessions.length, 1);
  console.log(
    'Passed: project drafts, reload, attachment, response-loss retries, Chinese and English',
  );
} catch (error) {
  console.error(error);
  throw error;
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
