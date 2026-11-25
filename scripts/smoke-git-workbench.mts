/**
 * @file 验证 Linux 安装件中的 Git 看板、开发会话与本机提交。
 * @implementation 在隔离目录使用真实 Electron、系统 Git、SDK 和回环模型核对双语文件视图、提交及工作树。
 * @updated 2026-11-24T04:50:56+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { z } from 'zod';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';
import { until } from './p1-smoke/contracts.mjs';
import { workspaceLayoutSchema } from '../shared/workspace-layout.js';

const artifact = process.argv[2];
assert.ok(artifact, 'Usage: node --import tsx scripts/smoke-git-workbench.mts <Arch package>');
const directory = await mkdtemp(join(tmpdir(), 'atelier-git-installed-'));
const repo = join(directory, 'fixture repository');
const install = join(directory, 'install');
const home = join(directory, 'home');
const data = join(directory, 'data');
const profile = join(directory, 'profile');
const model = 'atelier-git-loopback';
const branches = ['feature/login', 'feature/payments'] as const;
const reply = (branch: string) => 'Wrote fixture for ' + branch + '.';
const seed = (branch: string) => 'Isolated seed for ' + branch;
const update = (branch: string) => 'Updated by SDK in ' + branch + '\n';
const permission = z.object({ id: z.string(), status: z.string() });
const snapshot = z.object({
  session: z.object({ id: z.string(), status: z.string(), draft: z.object({ text: z.string() }) }),
  workspace: z.object({ id: z.string(), path: z.string(), branch: z.string(), state: z.string() }),
  permissions: z.array(permission),
  messages: z.array(
    z.object({ id: z.string(), text: z.string(), forkAnchor: z.unknown().optional() }),
  ),
});
const messageBlocks = z.object({
  system: z.unknown().optional(),
  tools: z.unknown().optional(),
  messages: z.array(z.object({ content: z.unknown() })),
});
const toolBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
  content: z.unknown(),
});
const modelErrors: string[] = [];
let commitDraftCalls = 0;
const observedReads = new Set<string>();
const observedWrites = new Set<string>();
const gateway = createServer(async (request, response) => {
  if (request.url === '/git-preview') {
    response.setHeader('Content-Type', 'text/html');
    return response.end('<title>Git fixture browser</title><p>Git fixture browser</p>');
  }
  if (request.method === 'GET') {
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify({ data: [{ model }] }));
  }
  try {
    assert.ok(request.url?.startsWith('/v1/messages') && !request.url.includes('count_tokens'));
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { system, tools, messages } = messageBlocks.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    if (typeof system === 'string' && system.startsWith('Write a concise Git commit message')) {
      commitDraftCalls++;
      assert.equal(tools, undefined);
      const scope = JSON.stringify(messages);
      assert.doesNotMatch(scope, /outside the staged snapshot|original checkout only/u);
      if (system.includes('Simplified Chinese')) {
        assert.match(scope, /暂存中的提交说明/u);
        response.setHeader('content-type', 'application/json');
        return response.end(
          JSON.stringify({
            content: [{ type: 'text', text: '记录暂存说明\n\n补充工作台的暂存提交流程。' }],
          }),
        );
      }
      assert.match(scope, /English staged review/u);
      response.statusCode = 502;
      return response.end('{}');
    }
    const branch = branches.find((item) =>
      JSON.stringify(messages).includes('GIT_FIXTURE ' + item),
    );
    assert.ok(branch, 'model request identifies its development session');
    const key = branch.split('/').at(-1);
    const read = 'toolu_git_read_' + key;
    const write = 'toolu_git_write_' + key;
    const results = messages.flatMap(({ content }) =>
      (Array.isArray(content) ? content : []).flatMap((block: unknown) => {
        const parsed = toolBlock.safeParse(block);
        return parsed.success ? [parsed.data] : [];
      }),
    );
    const readResult = results.find((item) => item.tool_use_id === read);
    const writeResult = results.find((item) => item.tool_use_id === write);
    if (writeResult) {
      assert.notEqual(writeResult.is_error, true, JSON.stringify(writeResult.content));
      observedWrites.add(branch);
      return sendModelReply(response, model, reply(branch));
    }
    if (readResult) {
      assert.notEqual(readResult.is_error, true, JSON.stringify(readResult.content));
      assert.ok(
        JSON.stringify(readResult.content).includes(seed(branch)),
        JSON.stringify(readResult.content),
      );
      observedReads.add(branch);
      return sendModelReply(response, model, [
        {
          id: write,
          name: 'mcp__atelier__write_file',
          input: {
            path: 'same.txt',
            content: update(branch),
            reason: 'Verify the worktree write.',
          },
        },
      ]);
    }
    return sendModelReply(response, model, [
      { id: read, name: 'Read', input: { file_path: 'same.txt' } },
    ]);
  } catch (error) {
    modelErrors.push(error instanceof Error ? error.message : String(error));
    return sendModelReply(response, model, 'Fixture model assertion failed.');
  }
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function sessionInfo(page: Page, id: string) {
  return snapshot.parse(
    await page.evaluate(async (sessionId) => {
      const response = await fetch('/api/sessions/' + sessionId);
      if (!response.ok) throw new Error('Could not read fixture session ' + response.status);
      return response.json();
    }, id),
  );
}

async function openSession(page: Page, id: string) {
  await page.evaluate((sessionId) => {
    location.hash = '/sessions/' + sessionId;
  }, id);
  await page
    .locator('[data-session-id="' + id + '"]')
    .first()
    .waitFor();
}

async function dragSeparator(page: Page, separator: Locator, delta: number) {
  const bounds = await separator.boundingBox();
  assert.ok(bounds);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
  await page.mouse.up();
}

async function readLayout(page: Page) {
  return workspaceLayoutSchema.parse(
    await page.evaluate(async () => {
      const response = await fetch('/api/settings/workspace-layout');
      if (!response.ok) throw new Error('Could not read layout ' + response.status);
      return response.json();
    }),
  );
}

async function createDevelopmentSession(page: Page, branch: string, english: boolean) {
  await page.locator('.topbar').getByRole('button', { name: 'Git', exact: true }).click();
  const board = page.locator('.git-board');
  const create = english ? 'New development session' : '新建开发会话';
  await board.getByRole('button', { name: create, exact: true }).click();
  const form = page.getByRole('dialog', { name: create, exact: true });
  await form.getByLabel(english ? 'New branch name' : '新分支名', { exact: true }).fill(branch);
  const linked = form.getByRole('radio', {
    name: english ? 'Create a separate worktree' : '创建独立工作树',
  });
  assert.equal(await linked.isChecked(), true);
  await form
    .getByRole('button', { name: english ? 'Preview development session' : '预览开发会话' })
    .click();
  await form
    .getByText(english ? 'Review branch and starting point' : '核对新分支和基线', { exact: true })
    .waitFor();
  await form
    .getByRole('button', {
      name: english ? 'Create development session' : '创建开发会话',
      exact: true,
    })
    .click();
  await form.waitFor({ state: 'hidden' });
  await page.locator('.git-session-chip').filter({ hasText: branch }).waitFor();
  const id = new URL(page.url()).hash.split('/')[2];
  assert.ok(id);
  const record = await sessionInfo(page, id);
  assert.equal(record.workspace.branch, branch);
  assert.equal(record.workspace.state, 'ready');
  assert.equal(git(record.workspace.path, 'branch', '--show-current').trim(), branch);
  return record;
}

async function approve(page: Page, id: string) {
  await openSession(page, id);
  await page.getByRole('button', { name: 'Review and approve', exact: true }).last().click();
  const decision = page
    .getByRole('dialog')
    .getByRole('button', { name: 'Allow this action', exact: true });
  await decision.click();
}

let app: ElectronApplication | undefined;
try {
  await Promise.all([repo, install, home].map((path) => mkdir(path)));
  execFileSync('/usr/bin/bsdtar', ['-xf', resolve(artifact), '-C', install], { stdio: 'ignore' });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(repo, 'same.txt'), 'identical committed base\n');
  await writeFile(join(repo, 'syntax.ts'), 'export const count = 1;\n');
  await writeFile(join(repo, 'notes.md'), '# Before\n');
  await writeFile(join(repo, '.gitignore'), 'cache/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial fixture commit');
  await writeFile(join(repo, 'same.txt'), 'original checkout only\n');
  await writeFile(join(repo, 'syntax.ts'), 'export const count = 2;\n');
  await writeFile(join(repo, 'notes.md'), '# After\n');
  await mkdir(join(repo, 'docs'));
  const stagedPath = join(repo, 'docs', 'staged-review.md');
  await writeFile(stagedPath, '# 暂存中的提交说明\n');
  git(repo, 'add', 'docs/staged-review.md');
  await writeFile(stagedPath, '# outside the staged snapshot\n');
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');
  const launch = () =>
    _electron.launch({
      executablePath: join(install, 'opt', 'atelier', 'atelier'),
      args: ['--disable-gpu', '--user-data-dir=' + profile],
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
        ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        ATELIER_DATA_DIR: data,
        ATELIER_PORT: '0',
        ATELIER_GATEWAY: 'http://127.0.0.1:' + address.port,
        ATELIER_MODEL: model,
        ATELIER_MAGPIE_URL: '',
      },
      timeout: 25_000,
    });
  app = await launch();
  let page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(repo);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });

  const opener = page.locator('.topbar').getByRole('button', { name: 'Git', exact: true });
  await opener.click();
  const board = page.locator('.git-board');
  const changedFile = board.locator('.git-file-row').filter({ hasText: /same\.txt/u });
  await changedFile.click();
  assert.equal(
    await changedFile.evaluate((button) => getComputedStyle(button).justifyContent),
    'flex-start',
  );
  assert.equal(
    await changedFile.evaluate(
      (button) => getComputedStyle(button.closest('ul') ?? button).listStyleType,
    ),
    'none',
  );
  const added = board.locator('.git-diff-line[data-kind=added]');
  await added.getByText('original checkout only', { exact: true }).waitFor();
  await board.locator('.git-file-row').filter({ hasText: /notes\.md/u }).click();
  await added.getByText('# After', { exact: true }).waitFor();
  await added.locator('.git-syntax-token').first().waitFor();
  const sourceFile = board.locator('.git-file-row').filter({ hasText: /syntax\.ts/u });
  await sourceFile.click();
  const keyword = added.locator('.git-syntax-token').getByText('const', { exact: true });
  await keyword.waitFor();
  const lightKeyword = await keyword.evaluate((node) => getComputedStyle(node).color);
  const removed = board.locator('.git-diff-line[data-kind=removed]');
  assert.equal((await added.locator('.git-diff-number').allTextContents()).join('/'), '/1');
  assert.equal((await removed.locator('.git-diff-number').allTextContents()).join('/'), '1/');
  const addedBg = await added.evaluate((node) => getComputedStyle(node).backgroundColor);
  const removedBg = await removed.evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.notEqual(addedBg, removedBg);
  const screenshot = process.env.ATELIER_GIT_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot });
  const divider = page.getByRole('separator', { name: '调整 Git 面板宽度' });
  const initial = await board.boundingBox();
  assert.ok(initial);
  await dragSeparator(page, divider, 106);
  await until(
    async () => {
      const current = await board.boundingBox();
      return current && current.width < initial.width - 70 ? current : undefined;
    },
    3000,
    'Git pane widened the conversation by dragging its divider',
  );
  const dragged = await board.boundingBox();
  assert.ok(dragged);
  await board.getByRole('button', { name: '全屏查看 Git' }).click();
  const full = page.getByRole('dialog', { name: 'Git', exact: true });
  await full.waitFor();
  assert.deepEqual(await full.boundingBox(), { x: 0, y: 0, width: 1280, height: 800 });
  assert.equal(await page.locator('#conversation').getAttribute('inert'), '');
  assert.equal(await sourceFile.getAttribute('aria-pressed'), 'true');
  await keyword.waitFor();
  const fullscreen = process.env.ATELIER_GIT_FULLSCREEN_SCREENSHOT;
  if (fullscreen) await page.screenshot({ path: fullscreen });
  await page.keyboard.press('Escape');
  await page.getByRole('region', { name: 'Git', exact: true }).waitFor();
  await until(
    async () => {
      const current = await board.boundingBox();
      return current && Math.abs(current.width - dragged.width) < 2 ? current : undefined;
    },
    3000,
    'restored the resized panel width',
  );
  assert.equal(await sourceFile.getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 1000, height: 720 });
  await full.waitFor();
  assert.deepEqual(await full.boundingBox(), { x: 0, y: 0, width: 1000, height: 720 });
  assert.equal(await sourceFile.getAttribute('aria-pressed'), 'true');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('region', { name: 'Git', exact: true }).waitFor();
  const aiCommit = board.getByRole('button', { name: 'AI 提交', exact: true });
  await aiCommit.click();
  const commitReview = page.getByRole('dialog', { name: '核对 Git 提交' });
  const commitTitle = commitReview.getByLabel('提交标题', { exact: true });
  const commitBody = commitReview.getByLabel('提交正文（可选）', { exact: true });
  await commitTitle.waitFor();
  assert.equal(await commitTitle.inputValue(), '记录暂存说明');
  assert.equal(await commitBody.inputValue(), '补充工作台的暂存提交流程。');
  await commitReview.getByText('staged-review.md', { exact: true }).waitFor();
  assert.equal(await commitReview.getByText('same.txt', { exact: true }).count(), 0);
  await commitTitle.fill('补充提交核对说明');
  await commitBody.fill('按编辑后的说明提交。\n保留未暂存内容。');
  const reviewShot = process.env.ATELIER_GIT_COMMIT_SCREENSHOT;
  if (reviewShot) await page.screenshot({ path: reviewShot });
  const reviewedHead = git(repo, 'rev-parse', 'HEAD').trim();
  await writeFile(stagedPath, '# New staged revision\n');
  git(repo, 'add', 'docs/staged-review.md');
  await writeFile(stagedPath, '# outside the staged snapshot\n');
  const confirm = commitReview.getByRole('button', { name: '确认提交', exact: true });
  await confirm.click();
  await commitReview.getByRole('alert').filter({ hasText: '暂存区或当前分支已变化' }).waitFor();
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), reviewedHead);
  assert.equal(await confirm.isEnabled(), false);
  await commitReview.getByRole('button', { name: '重新核对暂存区', exact: true }).click();
  await until(
    async () => (await confirm.isEnabled()) || undefined,
    4000,
    'reviewed the new staged version',
  );
  assert.equal(await commitTitle.inputValue(), '补充提交核对说明');
  assert.equal(await commitBody.inputValue(), '按编辑后的说明提交。\n保留未暂存内容。');
  await confirm.click();
  await commitReview.waitFor({ state: 'hidden' });
  await board.getByRole('status').filter({ hasText: '已创建提交' }).waitFor();
  assert.match(
    git(repo, 'log', '-1', '--format=%B'),
    /^补充提交核对说明\n\n按编辑后的说明提交。\n保留未暂存内容。/u,
  );
  assert.equal(git(repo, 'show', 'HEAD:docs/staged-review.md'), '# New staged revision\n');
  assert.equal(await readFile(stagedPath, 'utf8'), '# outside the staged snapshot\n');
  assert.equal(git(repo, 'diff', '--cached'), '');
  assert.equal(commitDraftCalls, 1);
  console.log(
    'Chinese AI draft, staged-only scope, edited message, stale retry, and local commit passed',
  );

  const filesTab = board.getByRole('tab', { name: '文件变动' });
  await filesTab.focus();
  await filesTab.press('ArrowRight');
  await board.getByRole('button', { name: /Initial fixture commit/u }).click();
  await added.getByText('identical committed base', { exact: true }).waitFor();
  await board.getByRole('heading', { name: 'syntax.ts', exact: true }).waitFor();
  await keyword.waitFor();
  await page.keyboard.press('Escape');
  await until(
    async () =>
      (await opener.evaluate((element) => element === document.activeElement)) || undefined,
    2500,
    'Git focus returned',
  );
  const one = await createDevelopmentSession(page, branches[0], false);
  console.log(
    'Chinese dock, drag, full-window and narrow layout, syntax, history, and creation passed',
  );

  const browserFixture = 'http://127.0.0.1:' + address.port + '/git-preview';
  const primaryApp = app;
  const nativeViews = () =>
    primaryApp.evaluate(({ BrowserWindow }) =>
      Math.max(
        ...BrowserWindow.getAllWindows().map((window) => window.contentView.children.length),
      ),
    );
  const baseViews = await nativeViews();
  const browserButton = page
    .locator('.topbar')
    .getByRole('button', { name: '浏览器', exact: true });
  await browserButton.click();
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  const addressBar = page.getByLabel('网页地址', { exact: true });
  await addressBar.fill(browserFixture);
  await addressBar.press('Enter');
  await page.locator('.desktop-browser-slot[aria-label="Git fixture browser"]').waitFor();
  await until(
    async () => (await nativeViews()) > baseViews || undefined,
    3000,
    'native view attached',
  );
  await opener.click();
  await board.waitFor();
  await until(
    async () => (await nativeViews()) === baseViews || undefined,
    3000,
    'Git hid the native view',
  );
  await board.getByRole('button', { name: '关闭 Git 面板', exact: true }).click();
  await page.locator('.desktop-browser-slot[aria-label="Git fixture browser"]').waitFor();
  await until(
    async () => (await nativeViews()) > baseViews || undefined,
    3000,
    'native view restored',
  );
  assert.equal(await addressBar.inputValue(), browserFixture);
  await browserButton.click();
  console.log('Native browser view detached for Git and remounted with its tab and URL');

  await page
    .locator('.topbar')
    .getByRole('button', { name: '模型与网关设置', exact: true })
    .click();
  await page.getByLabel('界面语言').click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await openSession(page, one.session.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Switch UI theme', exact: true }).click();
  const midnight = page.getByRole('option', { name: /Midnight Slate/u });
  await midnight.click();
  await midnight.waitFor({ state: 'hidden' });
  await writeFile(
    join(one.workspace.path, 'docs', 'english-review.md'),
    '# English staged review\n',
  );
  git(one.workspace.path, 'add', 'docs/english-review.md');
  const baseHead = git(repo, 'rev-parse', 'HEAD').trim();
  const windowSize = await primaryApp.evaluate(({ BrowserWindow }) => {
    const bounds = BrowserWindow.getAllWindows()[0]?.getContentBounds();
    return bounds && { width: bounds.width, height: bounds.height };
  });
  assert.ok(windowSize);
  await page.setViewportSize(windowSize);
  await opener.click();
  await board.locator('.git-file-row').filter({ hasText: /english-review\.md/u }).waitFor();
  const englishCommit = board.getByRole('button', { name: 'AI commit', exact: true });
  await englishCommit.click();
  const englishReview = page.getByRole('dialog', { name: 'Review Git commit', exact: true });
  await englishReview
    .getByRole('status')
    .filter({ hasText: 'The model could not draft a message' })
    .waitFor();
  await englishReview.getByText('english-review.md', { exact: true }).waitFor();
  await englishReview.getByLabel('Commit subject', { exact: true }).fill('Review staged notes');
  const englishShot = process.env.ATELIER_GIT_COMMIT_DARK_SCREENSHOT;
  if (englishShot) await page.screenshot({ path: englishShot });
  await englishReview.getByRole('button', { name: 'Confirm commit', exact: true }).click();
  await englishReview.waitFor({ state: 'hidden' });
  assert.equal(git(one.workspace.path, 'log', '-1', '--format=%s').trim(), 'Review staged notes');
  assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), baseHead);
  await englishCommit.press('Enter');
  await englishReview
    .getByRole('alert')
    .filter({ hasText: 'There are no staged changes' })
    .waitFor();
  await englishReview.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(commitDraftCalls, 2);
  console.log(
    'English model-unavailable fallback, linked worktree commit, and empty-index feedback passed',
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await board.getByRole('tab', { name: 'Branches and commits' }).click();
  await board.getByRole('button', { name: /Initial fixture commit/u }).click();
  await keyword.waitFor();
  assert.notEqual(await keyword.evaluate((node) => getComputedStyle(node).color), lightKeyword);
  await board.getByRole('button', { name: 'Expand Git to full window' }).click();
  await board.getByRole('button', { name: 'Dock Git sidebar' }).click();
  await page.setViewportSize({ width: 1920, height: 1080 });
  const resize = page.getByRole('separator', { name: 'Resize Git panel' });
  const beforeKeyboard = await board.boundingBox();
  assert.ok(beforeKeyboard);
  await resize.focus();
  await page.keyboard.press('ArrowLeft');
  const afterKeyboard = await until(
    async () => {
      const bounds = await board.boundingBox();
      return bounds && bounds.width > beforeKeyboard.width + 2 ? bounds : undefined;
    },
    3000,
    'Git resized using the keyboard',
  );
  await keyword.waitFor();
  const darkScreenshot = process.env.ATELIER_GIT_DARK_SCREENSHOT;
  if (darkScreenshot) await page.screenshot({ path: darkScreenshot });
  const navigation = page.locator('#navigation');
  const originalNavigation = await navigation.boundingBox();
  assert.ok(originalNavigation);
  const savedLayout = await readLayout(page);
  await dragSeparator(page, resize, -900);
  await until(
    async () => {
      const bounds = await board.boundingBox();
      return bounds && bounds.width > afterKeyboard.width + 200 ? bounds : undefined;
    },
    3000,
    'Git resized to its wide limit',
  );
  const finalNavigation = await navigation.boundingBox();
  assert.ok(finalNavigation && Math.abs(originalNavigation.width - finalNavigation.width) < 2);
  assert.deepEqual(await readLayout(page), savedLayout);
  await board.getByRole('button', { name: 'Close Git panel' }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  console.log('English controls, keyboard resize, dark syntax, and stable navigation width passed');
  const two = await createDevelopmentSession(page, branches[1], true);
  assert.notEqual(one.workspace.path, two.workspace.path);
  for (const record of [one, two]) {
    await writeFile(join(record.workspace.path, 'same.txt'), seed(record.workspace.branch) + '\n');
    await openSession(page, record.session.id);
    const composer = page.locator('#prompt-input');
    const suggestion = 'only-' + record.workspace.branch.split('/').at(-1) + '.txt';
    await writeFile(join(record.workspace.path, suggestion), 'worktree-local suggestion');
    await composer.fill('@only-');
    const expected = page.getByRole('option').filter({ hasText: suggestion });
    await expected.waitFor();
    assert.equal(await page.getByRole('option').filter({ hasText: /only-/u }).count(), 1);
    await composer.press('Escape');
    await composer.fill('GIT_FIXTURE ' + record.workspace.branch);
    await composer.press('Enter');
  }
  await until(
    async () => {
      assert.deepEqual(modelErrors, []);
      const status = await Promise.all(
        [one, two].map(({ session }) => sessionInfo(page, session.id)),
      );
      return (
        status.every((item) => item.permissions.some((value) => value.status === 'pending')) ||
        undefined
      );
    },
    20_000,
    'both real SDK turns reached controlled-write approval concurrently',
  );
  for (const record of [one, two]) {
    await approve(page, record.session.id);
    await page.getByText(reply(record.workspace.branch), { exact: true }).waitFor();
    assert.equal(
      await readFile(join(record.workspace.path, 'same.txt'), 'utf8'),
      update(record.workspace.branch),
    );
  }
  assert.deepEqual([...observedReads].sort(), [...branches].sort());
  assert.deepEqual([...observedWrites].sort(), [...branches].sort());
  assert.equal(await readFile(join(repo, 'same.txt'), 'utf8'), 'original checkout only\n');
  console.log('Real SDK relative reads and concurrent controlled writes passed');

  const first = one.workspace;
  await openSession(page, one.session.id);
  git(first.path, 'add', 'same.txt');
  await writeFile(join(first.path, 'same.txt'), 'unstaged follow-up\n');
  const binary = Buffer.from([0, 255, 0, 1, 39]);
  await writeFile(join(first.path, 'sample.bin'), binary);
  await mkdir(join(first.path, 'cache'));
  await writeFile(join(first.path, 'cache', 'rebuild'), 'cache');
  const statusBefore = git(first.path, 'status', '--porcelain=v2', '-z');
  const stageBefore = git(first.path, 'diff', '--cached');
  const composer = page.locator('#prompt-input');
  await composer.fill('Draft preserved across worktree restore');
  await until(
    async () =>
      (await sessionInfo(page, one.session.id)).session.draft.text ===
        'Draft preserved across worktree restore' || undefined,
    5000,
    'draft is persisted',
  );
  await page.getByRole('button', { name: /Manage session .*feature\/login/u }).click();
  await page.getByRole('menuitem', { name: 'Archive session' }).click();
  const archive = page.getByRole('dialog', { name: 'Archive session' });
  await archive.getByRole('button', { name: 'Archive session', exact: true }).click();
  await page.getByText('Some ignored paths still need your review.', { exact: true }).waitFor();
  assert.equal(await readFile(join(first.path, 'cache', 'rebuild'), 'utf8'), 'cache');
  await page.getByRole('button', { name: 'View worktrees', exact: true }).click();
  await board.getByRole('switch', { name: 'Mark cache as rebuildable' }).click();
  await until(
    async () =>
      (await board.getByRole('switch', { name: 'Mark cache as rebuildable' }).isChecked()) ||
      undefined,
    4000,
    'cache mark saved',
  );
  await board.getByRole('button', { name: 'Retry reclaim', exact: true }).click();
  await board.getByText('Snapshot saved and checkout reclaimed.', { exact: true }).waitFor();
  await board.getByRole('button', { name: 'Close Git panel' }).click();
  await assert.rejects(readFile(join(first.path, 'same.txt')), { code: 'ENOENT' });
  await page.getByRole('button', { name: 'Restore worktree', exact: true }).waitFor();

  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  await openSession(page, one.session.id);
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  const restoreButton = page.getByRole('button', { name: 'Restore worktree', exact: true });
  await restoreButton.click();
  const restore = page.getByRole('dialog', { name: 'Restore worktree' });
  await restore.getByRole('button', { name: 'Restore worktree', exact: true }).click();
  await restore.waitFor({ state: 'hidden' });
  await until(
    async () => (await sessionInfo(page, one.session.id)).workspace.state === 'ready' || undefined,
    5000,
    'worktree restored to its original path',
  );
  assert.equal(
    await page.locator('#prompt-input').inputValue(),
    'Draft preserved across worktree restore',
  );
  assert.equal(git(first.path, 'status', '--porcelain=v2', '-z'), statusBefore);
  assert.equal(git(first.path, 'diff', '--cached'), stageBefore);
  assert.deepEqual(await readFile(join(first.path, 'sample.bin')), binary);
  assert.equal(await readFile(join(first.path, 'same.txt'), 'utf8'), 'unstaged follow-up\n');
  assert.deepEqual(modelErrors, []);
  const restored = await sessionInfo(page, one.session.id);
  const anchor = restored.messages.find(
    ({ text, forkAnchor }) => text === reply(branches[0]) && forkAnchor,
  );
  assert.ok(anchor, 'the restored SDK turn retains a fork anchor');
  const child = await page.evaluate(
    async ({ sessionId, messageId, idempotencyKey }) => {
      const boot = await fetch('/api/bootstrap');
      const payload: unknown = await boot.json();
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('csrfToken' in payload) ||
        typeof payload.csrfToken !== 'string'
      )
        throw new Error('Missing fixture bootstrap token');
      const response = await fetch('/api/sessions/' + sessionId + '/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': payload.csrfToken },
        body: JSON.stringify({ messageId, idempotencyKey }),
      });
      if (response.status !== 201)
        throw new Error('Could not fork fixture session: ' + (await response.text()));
      return response.json();
    },
    { sessionId: one.session.id, messageId: anchor.id, idempotencyKey: randomUUID() },
  );
  const { session: forked } = z.object({ session: z.object({ id: z.uuid() }) }).parse(child);
  assert.deepEqual((await sessionInfo(page, forked.id)).workspace, restored.workspace);
  console.log(
    'English archive, ignored-cache protection, restart, byte-exact restore, and worktree inheritance passed',
  );
} finally {
  await app?.close();
  gateway.closeAllConnections();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
