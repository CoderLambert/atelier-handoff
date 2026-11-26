/**
 * @file 验证 GitHub Skill 在隔离 Electron 和真实 SDK 中的导入与调用。
 * @implementation 从公开仓库安装 Impeccable，使用回环模型验证中英文界面、资源读取、项目隔离及本机信任脚本调用。
 * @updated 2026-11-26T16:11:06+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { z } from 'zod';
import type { GitDevelopmentPreview, GitSessionWorkspace } from '../shared/git-workbench.js';
import type { Extension, Project, Session } from '../shared/types.js';
import { sendModelReply } from '../tests/fixtures/subagent-gateway.js';

const directory = await mkdtemp(join(tmpdir(), 'atelier-github-skill-desktop-'));
const projectDir = join(directory, 'project');
const secondDir = join(directory, 'other');
const cache = join(directory, 'impeccable-cache');
const source = 'https://github.com/pbakaus/impeccable.git';
const model = 'fixture-github-skill';
const readPrompt = 'GITHUB_SKILL_RESOURCE_READ';
const nativePrompt = 'GITHUB_SKILL_NATIVE_CONTEXT';
const evidence = process.argv[2] ? resolve(process.argv[2]) : undefined;
const errors: unknown[] = [];
const records: Record<string, unknown> = {};
const modelInput = z.object({
  messages: z.array(z.unknown()),
  tools: z.array(z.object({ name: z.string() })).optional(),
});
const toolResult = z.object({
  content: z
    .array(
      z.object({
        type: z.literal('tool_result'),
        tool_use_id: z.string(),
        is_error: z.boolean().optional(),
        content: z.unknown(),
      }),
    )
    .optional(),
});

function resultFor(messages: unknown[], id: string) {
  for (const message of messages) {
    const blocks = z.object({ content: z.array(z.unknown()) }).safeParse(message);
    if (!blocks.success) continue;
    const result = toolResult.safeParse({
      content: blocks.data.content.filter(
        (block) =>
          block && typeof block === 'object' && 'type' in block && block.type === 'tool_result',
      ),
    });
    const entry = result.data?.content?.find((item) => item.tool_use_id === id);
    if (entry) return entry;
  }
}
function quote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
const gateway = createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ model, id: model }] }));
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = modelInput.parse(JSON.parse(Buffer.concat(chunks).toString()));
    const serialized = JSON.stringify(input.messages);
    if (serialized.includes(nativePrompt)) {
      const id = 'toolu_github_native_context';
      const result = resultFor(input.messages, id);
      if (result) {
        assert.ok(!result.is_error, JSON.stringify(result));
        assert.match(
          JSON.stringify(result.content),
          /PRODUCT\.md|DESIGN\.md|atelier_github_context/i,
        );
        records.contextResult = result.content;
        sendModelReply(res, model, 'IMPECCABLE_CONTEXT_VERIFIED');
        return;
      }
      assert.ok(input.tools?.some(({ name }) => name === 'Bash'));
      const path = /"(?:directory)"\s*:\s*"([^"]+\/skill-packages-[^/"]+\/impeccable)"/.exec(
        serialized.replaceAll('\\"', '"'),
      )?.[1];
      assert.ok(
        path && path.startsWith(join(directory, 'data')),
        'The run exposes a private package directory',
      );
      records.packagePath = path;
      sendModelReply(res, model, [
        {
          name: 'Bash',
          id,
          input: {
            command: `IMPECCABLE_HOME=${quote(cache)} ${quote(join(path, 'scripts/impeccable'))} context`,
            description: 'Run the installed Impeccable context helper',
            timeout: 120000,
          },
        },
      ]);
      return;
    }
    if (serialized.includes(readPrompt)) {
      const id = 'toolu_github_package_read';
      const result = resultFor(input.messages, id);
      if (result) {
        assert.ok(!result.is_error, JSON.stringify(result));
        assert.match(JSON.stringify(result.content), /surface|design|impeccable/i);
        records.resourceRead = true;
        sendModelReply(res, model, 'PACKAGE_RESOURCE_VERIFIED');
        return;
      }
      assert.ok(input.tools?.some(({ name }) => name === 'mcp__atelier__read_skill_resource'));
      assert.ok(
        !input.tools?.some(({ name }) => name === 'Bash' || name.endsWith('__run_skill_script')),
      );
      sendModelReply(res, model, [
        {
          name: 'mcp__atelier__read_skill_resource',
          id,
          input: { skill: 'impeccable', path: 'reference/craft-floor.md' },
        },
      ]);
      return;
    }
    throw new Error('Unrecognized fixture prompt');
  } catch (error) {
    errors.push(error);
    res.writeHead(400).end();
  }
});
async function api<T>(page: Page, path: string, method = 'GET', payload?: unknown): Promise<T> {
  const response = await page.evaluate(
    async ({ path, method, payload }) => {
      const token =
        method === 'GET' ? '' : (await (await fetch('/api/bootstrap')).json()).csrfToken;
      const result = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Atelier-Token': token },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      return { status: result.status, result: await result.json() };
    },
    { path, method, payload },
  );
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.result));
  return response.result as T;
}

let app: ElectronApplication | undefined;
let page: Page | undefined;
let stage = 'launch';
try {
  await mkdir(projectDir);
  await mkdir(secondDir);
  await writeFile(
    join(projectDir, 'PRODUCT.md'),
    '# Product\n\natelier_github_context is an isolated desktop fixture.\n',
  );
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', projectDir, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  git('add', 'PRODUCT.md');
  git('-c', 'user.email=test@example.com', '-c', 'user.name=Fixture', 'commit', '-m', 'base');
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');
  app = await electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: [
      resolve('dist/desktop/main.mjs'),
      '--user-data-dir=' + join(directory, 'profile'),
      '--disable-gpu',
    ],
    env: {
      ...process.env,
      ATELIER_DATA_DIR: join(directory, 'data'),
      ATELIER_GATEWAY: 'http://127.0.0.1:' + address.port,
      ATELIER_GATEWAY_TOKEN: 'github-skill-fixture',
      ATELIER_MODEL: model,
      ATELIER_PORT: '0',
      ATELIER_NATIVE_EXECUTION: '1',
      ATELIER_MAGPIE_URL: '',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  const bind = page.getByRole('dialog', { name: '绑定项目目录' });
  await bind.getByLabel('本机目录').fill(projectDir);
  await bind.getByRole('button', { name: '绑定项目', exact: true }).click();
  await bind.waitFor({ state: 'hidden' });
  const origin = new URL(page.url()).origin;
  const go = (path: string) => page!.goto(`${origin}/#${path}`);
  const { projects } = await api<{ projects: Project[] }>(page, '/api/bootstrap');
  const project = projects.find(({ path }) => path === projectDir);
  assert.ok(project);
  const endpoint = `/api/projects/${project.id}`;
  const { session: preexisting } = await api<{ session: Session }>(page, '/api/sessions', 'POST', {
    projectId: project.id,
  });
  await go(`/sessions/${preexisting.id}`);
  await page.getByRole('button', { name: '本会话 Skills', exact: true }).click();
  const prior = page.getByRole('dialog', { name: '本会话 Skills' });
  await prior
    .getByText(/下一次新运行可用 \d+ 项/)
    .first()
    .waitFor();
  assert.equal(await prior.getByText('impeccable', { exact: true }).count(), 0);
  await page.keyboard.press('Escape');

  stage = 'GitHub discovery and installation in Chinese';
  await go('/extensions');
  await page.getByRole('button', { name: '从公开来源导入', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从公开来源导入' });
  if (process.env.ATELIER_TEST_GITHUB_AUTH === '1') {
    await dialog.getByRole('button', { name: '连接本机 GitHub 账号', exact: true }).click();
    await dialog.getByText(/GitHub 已连接/).waitFor();
  }
  await dialog.getByLabel('GitHub 仓库、目录或文件链接').fill(source);
  await dialog.getByRole('button', { name: '查询', exact: true }).click();
  const row = dialog.getByRole('button').filter({
    has: page.getByText('.claude/skills/impeccable/SKILL.md', { exact: true }),
  });
  await row.getByText('推荐 Claude 版', { exact: true }).waitFor({ timeout: 70_000 });
  assert.equal(await row.getAttribute('aria-pressed'), 'true');
  await dialog.getByRole('button', { name: '安装 Skill', exact: true }).waitFor();
  await dialog.locator('summary').filter({ hasText: '包内文件' }).click();
  await dialog.getByText('scripts/impeccable', { exact: true }).waitFor();
  await dialog.getByText('可执行', { exact: true }).waitFor();
  if (evidence) await page.screenshot({ path: join(evidence, 'github-skill-preview-zh.png') });
  const imported = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith('/public-import'),
    { timeout: 75_000 },
  );
  await dialog.getByRole('button', { name: '安装 Skill', exact: true }).click();
  const importResult = await imported;
  assert.ok(importResult.ok(), JSON.stringify(await importResult.json()));
  const done = page.getByRole('dialog', { name: '已导入当前项目' });
  await done.getByRole('button', { name: '到对话中使用', exact: true }).click({ timeout: 70_000 });
  const input = page.locator('#prompt-input');
  await input.waitFor({ state: 'visible' });
  await page
    .getByRole('button', { name: /移除.*impeccable/ })
    .first()
    .waitFor();
  const { items } = await api<{ items: Extension[] }>(page, endpoint + '/extensions');
  const skill = items.find(({ name }) => name === 'impeccable');
  assert.equal(skill?.origin?.github?.path, '.claude/skills/impeccable');
  assert.ok(skill?.kind === 'skill');
  assert.equal(skill.autoInvoke, false);
  records.commit = skill.origin?.github?.commit;
  await input.fill(readPrompt);
  await input.press('Enter');
  await page.getByText('PACKAGE_RESOURCE_VERIFIED', { exact: true }).waitFor({ timeout: 60_000 });

  stage = 'existing chat and project isolation';
  await go(`/sessions/${preexisting.id}`);
  await page.getByRole('button', { name: '本会话 Skills', exact: true }).click();
  await page
    .getByRole('dialog', { name: '本会话 Skills' })
    .getByText('impeccable', { exact: true })
    .waitFor();
  await page.keyboard.press('Escape');
  const { project: other } = await api<{ project: Project }>(page, '/api/projects', 'POST', {
    path: secondDir,
  });
  const { session: different } = await api<{ session: Session }>(page, '/api/sessions', 'POST', {
    projectId: other.id,
  });
  const otherSkills = await api<{ items: Array<{ id: string }> }>(
    page,
    `/api/skill-inheritance?sessionId=${different.id}`,
  );
  assert.ok(!otherSkills.items.some(({ id }) => id === skill.id));

  stage = 'English update UI and linked worktree native run';
  await go('/settings/models');
  await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
  await page.getByRole('option', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await go(`/sessions/${preexisting.id}`);
  await go('/extensions');
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page
    .getByText('Already using the latest version from this source.', { exact: true })
    .waitFor({ timeout: 70_000 });
  if (evidence) await page.screenshot({ path: join(evidence, 'github-skill-updates-en.png') });
  await page.keyboard.press('Escape');
  const dev = {
    requestId: randomUUID(),
    branch: 'impeccable-test',
    mode: 'linked',
    base: { kind: 'head' },
  };
  const { oid } = await api<GitDevelopmentPreview>(page, endpoint + '/git/preview', 'POST', dev);
  const { session, workspace } = await api<{ session: Session; workspace: GitSessionWorkspace }>(
    page,
    endpoint + '/git/sessions',
    'POST',
    { ...dev, expectedOid: oid },
  );
  records.workspacePath = workspace.path;
  await go(`/sessions/${session.id}`);
  await page.getByRole('combobox', { name: 'Run mode', exact: true }).click();
  await page.getByRole('option', { name: /Trust this device/ }).click();
  await input.fill('/impeccable');
  await page.getByRole('option', { name: /impeccable/ }).click();
  await input.fill(nativePrompt);
  await input.press('Enter');
  await page
    .getByText('IMPECCABLE_CONTEXT_VERIFIED', { exact: true })
    .waitFor({ timeout: 150_000 });
  assert.deepEqual(errors, []);
  records.electron = await app.evaluate(() => process.versions.electron);
  console.log(JSON.stringify(records, null, 2));
} catch (error) {
  if (evidence && page)
    await page
      .screenshot({ path: join(evidence, 'github-skill-smoke-failure.png') })
      .catch(() => undefined);
  console.error(stage, errors, records);
  if (page)
    console.error(
      (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(-3000),
    );
  throw error;
} finally {
  await app?.close();
  await new Promise<void>((done) => gateway.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}
