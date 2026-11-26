/**
 * @file 验收真实桌面工作台的快捷操作与状态保留。
 * @implementation 使用隔离项目、数据和 profile 验证面板与输入焦点、Git 面板恢复后实时订阅、连续输入跨会话草稿保留及配置恢复，不发送模型请求。
 * @updated 2026-11-27T01:26:00+08:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { _electron, type ElectronApplication } from 'playwright-core';
import { build } from 'esbuild';
import { z } from 'zod';
import { terminalListResponseSchema } from '../shared/terminal.js';
import { shortcutPreferencesSchema } from '../shared/shortcuts.js';

const directory = await mkdtemp(join(tmpdir(), 'atelier-shortcuts-smoke-'));
const project = join(directory, 'project');
const evidence = resolve(process.env.ATELIER_SHORTCUT_EVIDENCE ?? '.local/workbench-shortcuts');
const run = promisify(execFile);
const model = 'shortcut-fixture-no-inference';
const isolatedHost = process.env.ATELIER_SHORTCUT_FIXTURE === '1';
let modelRequests = 0;
let application: ElectronApplication | undefined;
let completed = false;
const checked: string[] = [];
const gateway = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'GET') {
    modelRequests++;
    response.writeHead(400).end('{}');
  } else response.end(JSON.stringify(request.url === '/routes' ? { data: [{ model }] } : {}));
});

try {
  await Promise.all([mkdir(project), mkdir(evidence, { recursive: true })]);
  await writeFile(join(project, 'README.md'), '# Shortcut integration fixture\n');
  await run('git', ['init', '-b', 'main', project]);
  await run('git', ['-C', project, 'add', 'README.md']);
  await run('git', [
    '-C',
    project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create isolated fixture',
  ]);
  await writeFile(join(project, 'README.md'), '# Shortcut integration fixture\n\nLocal change.\n');
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address !== 'string');
  const entry = isolatedHost
    ? join(directory, 'workbench-shortcuts.mjs')
    : resolve('dist/desktop/main.mjs');
  if (isolatedHost)
    await build({
      entryPoints: ['tests/fixtures/workbench-shortcuts-app.ts'],
      outfile: entry,
      absWorkingDir: resolve('.'),
      bundle: true,
      target: 'node24',
      platform: 'node',
      format: 'esm',
      external: ['electron'],
    });
  application = await _electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      entry,
      `--user-data-dir=${join(directory, 'profile')}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      ...(process.platform === 'linux'
        ? ['--ozone-platform=headless', '--ozone-override-screen-size=1440,900']
        : []),
    ],
    env: {
      ...process.env,
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_PORT: '0',
      ATELIER_GATEWAY: `http://127.0.0.1:${address.port}`,
      ATELIER_MODEL: model,
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_MAGPIE_URL: '',
    },
    timeout: 30_000,
  });
  const app = application;
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(project);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  await page.waitForURL((url) => /^#\/sessions\/[a-f0-9-]+$/u.test(url.hash));
  const firstId = z.uuid().parse(new URL(page.url()).hash.split('/')[2]);
  const origin = new URL(page.url()).origin;
  const conversation = `${origin}/#/sessions/${firstId}`;
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
  );
  await page.locator('#prompt-input').fill('保留我的会话草稿');
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  async function navigate(key: string) {
    await page.keyboard.press(`${modifier}+Shift+Semicolon`);
    const dialog = page.getByRole('dialog', { name: '快捷导航', exact: true });
    await dialog.waitFor();
    await page.keyboard.press(key);
    await dialog.waitFor({ state: 'hidden' });
  }
  async function terminalIds() {
    const value: unknown = await page.evaluate(async (id) => {
      const response = await fetch(`/api/sessions/${id}/terminals`);
      if (!response.ok) throw new Error(`Terminal list ${response.status}`);
      return response.json();
    }, firstId);
    return terminalListResponseSchema.parse(value).terminals.map((terminal) => terminal.terminalId);
  }

  await navigate('h');
  await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor();
  await navigate('h');
  await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor();
  checked.push('left sidebar toggle from composer and navigation');

  await navigate('g');
  const board = page.locator('.git-board');
  await board.waitFor();
  const commit = board.locator('textarea').first();
  await commit.fill('未提交的 Git 文本');
  await navigate('l');
  await board.waitFor({ state: 'hidden' });
  await writeFile(
    join(project, 'README.md'),
    '# Shortcut integration fixture\n\nChanged while hidden.\n',
  );
  await navigate('l');
  await board.waitFor();
  assert.equal(await commit.inputValue(), '未提交的 Git 文本');
  checked.push('right collapse restores Git component state');
  await board
    .locator('.git-diff-line[data-kind=added]')
    .getByText('Changed while hidden.', { exact: true })
    .waitFor();
  await writeFile(
    join(project, 'README.md'),
    '# Shortcut integration fixture\n\nChanged after restore.\n',
  );
  await board
    .locator('.git-diff-line[data-kind=added]')
    .getByText('Changed after restore.', { exact: true })
    .waitFor();
  checked.push('restored Git panel refreshes hidden edits and resumes live change subscription');

  await navigate('t');
  const terminal = page.locator('.terminal-panel');
  await terminal.waitFor();
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
  const initialTerminals = await terminalIds();
  assert.equal(initialTerminals.length, 1);
  await page.locator('.xterm-helper-textarea').focus();
  await navigate('l');
  await terminal.waitFor({ state: 'hidden' });
  await navigate('l');
  await terminal.waitFor();
  assert.deepEqual(await terminalIds(), initialTerminals);
  await navigate('t');
  assert.deepEqual(await terminalIds(), initialTerminals);
  checked.push('terminal shortcut capture and idempotent restore without new PTY');

  await navigate('b');
  await page.locator('.desktop-browser').waitFor();
  await navigate('l');
  await page.locator('.desktop-browser').waitFor({ state: 'hidden' });
  await navigate('l');
  await page.locator('.desktop-browser').waitFor();
  checked.push('browser panel open and collapse/restore');

  await page.goto(`${conversation}/artifacts`);
  await page.getByRole('tab', { name: /交付物/u }).waitFor();
  await navigate('i');
  await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
  assert.equal(await page.locator('#prompt-input').inputValue(), '保留我的会话草稿');
  checked.push('input focus returns from content page without losing draft');

  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await page.waitForURL(
    (url) => /^#\/sessions\/[a-f0-9-]+$/u.test(url.hash) && !url.hash.includes(firstId),
  );
  const secondId = z.uuid().parse(new URL(page.url()).hash.split('/')[2]);
  const secondDraft = '第二个会话草稿 typing continuously';
  await page.locator('#prompt-input').focus();
  await page.locator('#prompt-input').pressSequentially(secondDraft);
  await page.keyboard.press(`${modifier}+Semicolon`);
  const switcher = page.getByRole('dialog', { name: '切换会话', exact: true });
  await switcher.waitFor();
  assert.equal(await switcher.getByRole('option').count(), 2);
  await switcher.getByRole('combobox').fill('project');
  assert.equal(await switcher.getByRole('option').count(), 2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(conversation);
  assert.equal(await page.locator('#prompt-input').inputValue(), '保留我的会话草稿');
  await navigate('j');
  await page.waitForURL(`${origin}/#/sessions/${secondId}`);
  assert.equal(await page.locator('#prompt-input').inputValue(), secondDraft);
  checked.push(
    'continuous typing, conversation search and adjacent navigation preserve both drafts',
  );

  await page.locator('#prompt-input').focus();
  await page.keyboard.press(`${modifier}+Semicolon`);
  await switcher.waitFor();
  await switcher.getByRole('combobox').evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(await switcher.isVisible(), true);
  const compositionEnded = await switcher.getByRole('combobox').evaluate((element) => {
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    return performance.now();
  });
  await page.waitForFunction((ended) => performance.now() > ended + 85, compositionEnded);
  await page.keyboard.press('Escape');
  await switcher.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
  checked.push('IME Escape keeps picker open; cancel restores composer focus');

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(720, 800),
  );
  await navigate('h');
  await page.getByRole('dialog', { name: '工作空间导航', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await navigate('g');
  await page.locator('.git-board[data-expanded="true"]').waitFor();
  await navigate('k');
  await page.waitForURL(conversation);
  await page.locator('.git-board').waitFor({ state: 'hidden' });
  assert.equal(
    await page.locator('#prompt-input').evaluate((element) => Boolean(element.closest('[inert]'))),
    false,
  );
  checked.push('conversation switch reveals center under full-window Git');
  await navigate('b');
  await page.locator('.desktop-browser').waitFor();
  await navigate('i');
  await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
  await page.locator('.desktop-browser').waitFor({ state: 'hidden' });
  checked.push('narrow window navigation drawer and browser-to-composer focus');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900),
  );

  await navigate(',');
  await page.getByRole('heading', { name: '快捷操作', exact: true }).waitFor();
  const record = page.getByRole('button', { name: '展开 / 收起左侧栏的直接快捷键', exact: true });
  await record.click();
  await page.keyboard.press(`${modifier}+Shift+Period`);
  await page.getByRole('button', { name: '保存快捷键', exact: true }).click();
  await page.getByText('快捷键已保存。', { exact: true }).waitFor();
  const preferences: unknown = await page.evaluate(async () =>
    (await fetch('/api/settings/shortcuts')).json(),
  );
  assert.equal(
    shortcutPreferencesSchema.parse(preferences).bindings['layout.toggleLeft']?.code,
    'Period',
  );
  await page.goto(conversation);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor();
  await page.keyboard.press(`${modifier}+Shift+Period`);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).waitFor();
  await page.keyboard.press(`${modifier}+Shift+Period`);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).waitFor();
  checked.push('custom direct shortcut persists across renderer reload');

  await page.keyboard.press(`${modifier}+Shift+Semicolon`);
  await page.getByRole('dialog', { name: '快捷导航', exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, 'quick-navigation.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  assert.equal(modelRequests, 0);
  await writeFile(
    join(evidence, 'result.json'),
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        isolatedHost,
        checked,
        modelRequests,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  completed = true;
  console.log(JSON.stringify({ result: 'passed', checks: checked.length, evidence }));
} finally {
  if (application) await application.close().catch(() => {});
  await new Promise<void>((done) => gateway.close(() => done()));
  if (completed) await rm(directory, { recursive: true, force: true });
  else console.error(`Shortcut smoke failed; isolated fixture retained at ${directory}`);
}
