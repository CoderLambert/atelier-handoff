/**
 * @file 验收 Git 面板跟随外部文件和运行中对话的变动。
 * @implementation 在隔离 Electron 中先发送对话，再打开 Git 面板并分别释放暂存与提交步骤，核对两种语言的自动刷新。
 * @updated 2026-11-27T00:10:00+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';

const model = 'fixture-live-git';
const reply = 'The fixture has committed.';
const subject = 'Commit from unfinished conversation';
const directory = await mkdtemp(join(tmpdir(), 'atelier-live-git-'));
const repo = join(directory, 'project');
const home = join(directory, 'home');
await Promise.all([mkdir(repo), mkdir(home)]);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-b', 'main');
git('config', 'user.name', 'Live Git Fixture');
git('config', 'user.email', 'fixture@example.test');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.hooksPath', '/dev/null');
await writeFile(join(repo, 'hello.txt'), 'hello\n');
git('add', 'hello.txt');
git('commit', '-m', 'initial');

let replyToTool: ServerResponse | undefined;
const gateway = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: model, model }] }));
    return;
  }
  let body = '';
  for await (const chunk of request) body += String(chunk);
  if (body.includes('FIXTURE_COMMITTED')) {
    replyToTool = response;
    return;
  }
  sendModelReply(response, model, [
    {
      name: 'Bash',
      id: 'toolu_live_git_commit',
      input: {
        description: 'Stage and commit an isolated fixture file',
        command: [
          'while ! test -f .git/allow-fixture-stage; do sleep 0.05; done',
          "printf 'conversation change\\n' > hello.txt",
          'git add -- hello.txt',
          'while ! test -f .git/allow-fixture-commit; do sleep 0.05; done',
          `git commit -m '${subject}'`,
          "printf 'FIXTURE_' && printf 'COMMITTED\\n'",
        ].join(' && '),
        timeout: 40_000,
      },
    },
  ]);
});

let app: ElectronApplication | undefined;
let page: Awaited<ReturnType<ElectronApplication['firstWindow']>> | undefined;
try {
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === 'object');
  const install = process.argv[2] ? resolve(process.argv[2]) : undefined;
  app = await electron.launch({
    executablePath: install
      ? join(install, 'opt', 'atelier', 'atelier')
      : resolve('node_modules/electron/dist/electron'),
    args: [
      ...(install ? [] : [resolve('dist/desktop/main.mjs')]),
      `--user-data-dir=${join(directory, 'profile')}`,
      '--disable-gpu',
    ],
    env: {
      ...process.env,
      HOME: home,
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_GATEWAY: 'http://127.0.0.1:' + gatewayAddress.port,
      ATELIER_GATEWAY_TOKEN: 'git-loopback',
      ATELIER_MODEL: model,
      ATELIER_PORT: '0',
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_MAGPIE_URL: '',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10_000);
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(repo);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  const mode = page.getByRole('combobox', { name: '运行模式', exact: true });
  await mode.click();
  await page.getByRole('option', { name: /^本机信任/u }).click();
  await page.locator('#prompt-input').fill('Stage then commit the live Git fixture.');
  await page.locator('#prompt-input').press('Enter');
  const openStream = page.waitForResponse((response) => response.url().endsWith('/changes'));
  await page.locator('.topbar').getByRole('button', { name: 'Git', exact: true }).click();
  assert.equal((await openStream).status(), 200);
  const board = page.locator('.git-board');
  await board.getByText('0 个文件变动', { exact: true }).waitFor();

  await writeFile(join(repo, '.git', 'allow-fixture-stage'), '');
  await board.getByText('1 个暂存文件', { exact: true }).waitFor();
  assert.equal(git('--no-optional-locks', 'status', '--porcelain'), 'M  hello.txt');
  await board
    .locator('.git-diff-line[data-kind=added]')
    .getByText('conversation change', { exact: true })
    .waitFor();
  console.log('staged file and diff rendered while the Bash tool waited');

  await writeFile(join(repo, '.git', 'allow-fixture-commit'), '');
  await board.getByText('0 个文件变动', { exact: true }).waitFor();
  await board.getByRole('tab', { name: '分支与提交', exact: true }).click();
  await board.getByText(subject, { exact: true }).first().waitFor();
  assert.equal(git('log', '-1', '--format=%s'), subject);
  assert.equal(await page.getByText(reply, { exact: true }).count(), 0);
  console.log('file count and history refreshed before the conversation finished');

  await board.getByText('initial', { exact: true }).first().click();
  const detail = board.locator('.git-commit-detail-header');
  await detail.getByText('initial', { exact: true }).waitFor();
  git('commit', '--allow-empty', '-m', 'External commit while inspecting history');
  await board
    .getByText('External commit while inspecting history', { exact: true })
    .waitFor({ state: 'attached' });
  assert.equal(await detail.getByText('initial', { exact: true }).count(), 1);

  for (const contents of ['first external edit', 'second external edit']) {
    await board.getByRole('tab', { name: '文件变动', exact: true }).click();
    await writeFile(join(repo, 'hello.txt'), contents + '\n');
    await board.getByText('1 个文件变动', { exact: true }).waitFor();
    await board
      .locator('.git-diff-line[data-kind=added]')
      .getByText(contents, { exact: true })
      .waitFor();
  }
  assert.ok(replyToTool);
  const screenshot = process.env.ATELIER_GIT_LIVE_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot });
  await board.getByRole('button', { name: '收起 Git 面板', exact: true }).click();
  sendModelReply(replyToTool, model, reply);
  await page.getByText(reply, { exact: true }).waitFor();
  console.log('external edits refreshed the diff twice with the same file status');

  const conversation = page.url();
  await page.goto(new URL('/#/settings/models', conversation).href);
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.goto(conversation);
  await page.locator('#prompt-input').waitFor();
  if (!(await board.isVisible()))
    await page.locator('.topbar').getByRole('button', { name: 'Git', exact: true }).click();
  await board.getByRole('tab', { name: 'File changes', exact: true }).click();
  await board.getByText('1 changed file', { exact: true }).waitFor();
  await writeFile(join(repo, 'hello.txt'), 'conversation change\n');
  await board.getByText('0 changed files', { exact: true }).waitFor();
  console.log('English file count refreshed after recreating the Git panel');
} catch (error) {
  const screenshot = process.env.ATELIER_GIT_LIVE_SCREENSHOT;
  if (screenshot) await page?.screenshot({ path: screenshot + '.failure.png' }).catch(() => {});
  throw error;
} finally {
  replyToTool?.destroy();
  await app?.close();
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
