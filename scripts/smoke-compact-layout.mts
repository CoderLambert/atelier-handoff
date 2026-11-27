/**
 * @file 在隔离 Electron 渲染器中验收紧凑工作台布局。
 * @implementation 加载真实前端入口和回环 API 夹具，保持渲染沙箱开启，验证双语尺寸、导航及焦点并保存截图和 JSON；不启动生产 main、模型或用户数据。
 * @updated 2026-11-26T17:12:24+08:00
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'esbuild';
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { z } from 'zod';
import type {
  AppConfig,
  Artifact,
  GatewayModelCatalog,
  Message,
  Project,
  Run,
  Session,
  ToolCall,
} from '../shared/types.js';
import { initialWorkspaceLayout, workspaceLayoutSchema } from '../shared/workspace-layout.js';

// Run from any directory: node --import tsx scripts/smoke-compact-layout.mts
// This is renderer acceptance with synthetic API/native-bridge data, not a production-main smoke.
const root = fileURLToPath(new URL('..', import.meta.url));
const evidenceRoot = join(root, '.local/compact-layout');
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, 'run-'));
const firstId = '22222222-2222-4222-8222-222222222222';
const secondId = '22222222-2222-4222-8222-333333333333';
const otherId = '22222222-2222-4222-8222-444444444444';
const at = '2026-11-26T10:00:00.000Z';
const draftText = '保留的草稿 / Preserved draft';
const longTitle =
  '紧凑布局验收 — A deliberately long session title that must stay readable without widening the workspace or pushing its controls away';
const projects: [Project, Project] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Alpha workspace',
    path: '/fixture/alpha',
    branch: 'fixture-alpha',
    available: true,
    createdAt: at,
  },
  {
    id: '11111111-1111-4111-8111-222222222222',
    name: 'Beta workspace',
    path: '/fixture/beta',
    branch: 'fixture-beta',
    available: true,
    createdAt: at,
  },
];
const firstProject = projects[0];
const otherProject = projects[1];
assert.ok(firstProject && otherProject);
const session = (id: string, projectId: string, title: string): Session => ({
  id,
  projectId,
  title,
  status: 'active',
  sdkSessionId: null,
  createdAt: at,
  updatedAt: at,
  draft: {
    text: draftText,
    mode: 'readonly',
    model: 'fixture-model',
    contextPaths: [],
    attachmentIds: [],
  },
});
const originalSessions = [
  session(firstId, firstProject.id, longTitle),
  session(secondId, firstProject.id, 'Alpha follow-up session'),
  session(otherId, otherProject.id, 'Beta project session'),
];
let sessions = structuredClone(originalSessions);
let layout = structuredClone(initialWorkspaceLayout);
const config: AppConfig = {
  gateway: 'http://fixture.invalid',
  model: 'fixture-model',
  maxTurns: 1,
  timeoutMs: 1000,
};
const run: Run = {
  id: '33333333-3333-4333-8333-333333333333',
  sessionId: firstId,
  projectId: firstProject.id,
  prompt: 'Review the compact workspace layout.',
  status: 'completed',
  mode: 'readonly',
  createdAt: at,
  startedAt: at,
  endedAt: at,
  reason: null,
  error: null,
  retryOf: null,
  contextPaths: [],
  attachmentIds: [],
  plan: [],
  usage: null,
  config,
};
const tool: ToolCall = {
  id: '55555555-5555-4555-8555-555555555555',
  runId: run.id,
  sessionId: firstId,
  name: 'Read',
  inputSummary: 'layout-report.txt',
  status: 'succeeded',
  output: 'Fixture read completed.',
  startedAt: at,
  endedAt: at,
};
const artifactText = 'Compact layout review: navigation, keyboard access and viewport sizing.';
const artifact: Artifact = {
  id: '66666666-6666-4666-8666-666666666666',
  runId: run.id,
  sessionId: firstId,
  projectId: firstProject.id,
  name: 'layout-report.txt',
  mime: 'text/plain',
  size: Buffer.byteLength(artifactText),
  fingerprint: createHash('sha256').update(artifactText).digest('hex'),
  availability: 'available',
  createdAt: at,
};
const failedRun: Run = {
  ...run,
  id: '33333333-3333-4333-8333-444444444444',
  sessionId: secondId,
  status: 'failed',
  error: 'Fixture execution failed.',
};
const failedMessages: Message[] = [
  {
    id: '44444444-4444-4444-8444-333333333333',
    sessionId: secondId,
    runId: failedRun.id,
    role: 'user',
    text: '验证失败后仍能查看执行轨迹并重新开始。',
    createdAt: at,
  },
];
const messages: Message[] = [
  {
    id: '44444444-4444-4444-8444-111111111111',
    sessionId: firstId,
    runId: run.id,
    role: 'user',
    text: '检查会话、项目和输入框是否始终可达。',
    createdAt: at,
  },
  {
    id: '44444444-4444-4444-8444-222222222222',
    sessionId: firstId,
    runId: run.id,
    role: 'assistant',
    text: 'The fixture contains two projects, a long session title, and a saved draft. No model is called.',
    createdAt: at,
  },
];
const catalog: GatewayModelCatalog = {
  defaultModel: config.model,
  routesAvailable: true,
  models: [{ id: config.model }],
  discovery: {
    routes: { status: 'ready', modelCount: 1 },
    codex: { status: 'ready', modelCount: 0 },
  },
};
const requests: string[] = [];
const unexpectedRequests: string[] = [];
const errors: string[] = [];
const serverErrors: string[] = [];
const cases: CaseResult[] = [];
type Locale = 'zh-CN' | 'en';
interface CaseResult {
  locale: Locale;
  width: number;
  height: number;
  checks: string[];
  measurements?: Record<string, number>;
  conversationRows?: string;
  screenshot?: string;
  error?: string;
}
const labels = {
  'zh-CN': {
    navigation: '工作空间导航',
    menu: '会话与项目',
    all: '全部会话',
    projects: '工作空间设置',
    openProjects: '打开工作空间设置',
    projectDialog: '绑定项目目录',
    search: '搜索项目或会话',
    closeSearch: '关闭搜索',
    collapse: '收起侧栏',
    expand: '展开侧栏',
    conversation: '会话',
    trace: '执行轨迹',
    artifacts: '交付物',
    runs: '执行记录',
    extensions: '扩展',
    agents: '智能体',
    settings: '工作台设置',
    mode: '运行模式',
    readonly: '只读',
    model: '模型与推理深度',
    terminal: '终端',
    browser: '浏览器',
    closeTerminal: '收起终端面板',
    closeBrowser: '收起浏览器面板',
    context: '上下文',
    upload: '上传附件',
    currentConversation: '当前会话内容',
    viewTrace: '查看执行轨迹',
    runResult: '本轮运行结果',
    retry: '只读续接',
    previewArtifact: '预览：layout-report.txt',
    downloadArtifact: '下载：layout-report.txt',
    toolSummary: '1 / 1 项工具',
  },
  en: {
    navigation: 'Workspace navigation',
    menu: 'Sessions and projects',
    all: 'All sessions',
    projects: 'Workspace settings',
    openProjects: 'Open workspace settings',
    projectDialog: 'Bind a project directory',
    search: 'Search projects or sessions',
    closeSearch: 'Close search',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    conversation: 'Conversation',
    trace: 'Activity',
    artifacts: 'Deliverables',
    runs: 'Run history',
    extensions: 'Extensions',
    agents: 'Agents',
    settings: 'Workbench settings',
    mode: 'Run mode',
    readonly: 'Read only',
    model: 'Model and reasoning effort',
    terminal: 'Terminal',
    browser: 'Browser',
    closeTerminal: 'Hide terminal panel',
    closeBrowser: 'Hide browser panel',
    context: 'Context',
    upload: 'Upload attachment',
    currentConversation: 'Current conversation',
    viewTrace: 'View execution trace',
    runResult: 'Run result for this turn',
    retry: 'Resume read-only',
    previewArtifact: 'Preview: layout-report.txt',
    downloadArtifact: 'Download: layout-report.txt',
    toolSummary: '1 / 1 tool',
  },
} as const;

async function sourceDigest() {
  const hash = createHash('sha256');
  for (const directory of ['frontend/src', 'shared/i18n']) {
    const base = join(root, directory);
    const files = (await readdir(base, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(?:tsx?|css)$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();
    for (const file of files) hash.update(relative(root, file)).update(await readFile(file));
  }
  return hash.digest('hex');
}

function snapshot(current: Session) {
  const project = projects.find(({ id }) => id === current.projectId);
  assert.ok(project);
  return {
    session: current,
    project,
    runs: current.id === firstId ? [run] : current.id === secondId ? [failedRun] : [],
    messages: current.id === firstId ? messages : current.id === secondId ? failedMessages : [],
    tools: current.id === firstId ? [tool] : [],
    permissions: [],
    artifacts: current.id === firstId ? [artifact] : [],
    attachments: [],
    events: [],
    cursor: 0,
  };
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(response: ServerResponse, value: unknown) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}

async function fixtureApi(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://fixture.invalid');
  const path = url.pathname;
  const method = request.method ?? 'GET';
  requests.push(`${method} ${path}`);
  if (path === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    response.write(': isolated compact-layout fixture\n\n');
    return;
  }
  if (path === '/api/bootstrap')
    return json(response, {
      csrfToken: 'compact-layout-fixture',
      cursor: 0,
      projects,
      sessions,
      runs: [run, failedRun],
      artifacts: [artifact],
      config,
      capabilities: { commands: false },
      connection: { available: true, message: 'fixture' },
    });
  if (path === '/api/config')
    return json(response, {
      config,
      capabilities: { commands: false },
      connection: { available: true, message: 'fixture' },
    });
  if (path === '/api/models') return json(response, catalog);
  if (path === '/api/terminals/capabilities')
    return json(response, {
      supported: false,
      reason: 'desktop-required',
      runtimeId: '44444444-4444-4444-8444-444444444444',
      shellName: null,
      protocolVersion: 1,
      limits: { perRuntime: 8, perSession: 4 },
    });
  if (path === '/api/settings/workspace-layout') {
    if (method === 'PATCH') layout = workspaceLayoutSchema.parse(await body(request));
    return json(response, layout);
  }
  if (path === '/api/settings/workspace-location') {
    const location =
      method === 'PATCH' ? z.object({ path: z.string() }).parse(await body(request)) : {};
    return json(response, location);
  }
  if (path === '/api/runs') {
    const status = url.searchParams.get('status');
    const sessionId = url.searchParams.get('sessionId');
    const items = [run, failedRun].filter(
      (item) => (!status || item.status === status) && (!sessionId || item.sessionId === sessionId),
    );
    return json(response, { items, total: items.length, nextOffset: null });
  }
  if (path === '/api/artifacts') {
    const sessionId = url.searchParams.get('sessionId');
    const items = !sessionId || sessionId === firstId ? [artifact] : [];
    return json(response, { items, total: items.length, nextOffset: null });
  }
  if (path === `/api/runs/${run.id}/trace` || path === `/api/runs/${failedRun.id}/trace`)
    return json(response, { events: [], eventCount: 0 });
  if (/^\/api\/projects\/[^/]+\/desktop-browser$/.test(path))
    return json(response, { enabled: false, available: true, revision: null });
  if (/^\/api\/projects\/[^/]+\/extensions$/.test(path)) return json(response, { items: [] });
  if (path === '/api/sessions' && method === 'POST') {
    const { projectId } = z.object({ projectId: z.uuid() }).parse(await body(request));
    assert.ok(projects.some(({ id }) => id === projectId));
    const created = session(randomUUID(), projectId, 'New fixture project session');
    sessions.push(created);
    return json(response, { session: created });
  }
  const match = /^\/api\/sessions\/([^/]+)$/.exec(path);
  const current = match ? sessions.find(({ id }) => id === match[1]) : undefined;
  if (current && method === 'GET') return json(response, snapshot(current));
  unexpectedRequests.push(`${method} ${path}`);
  response.statusCode = 404;
  json(response, {
    error: { message: `Unexpected compact-layout fixture request: ${method} ${path}` },
  });
}

// The browser bridge is deliberately synthetic. The real React desktop path still renders.
const fixtureEntry = `
const locale = new URLSearchParams(location.search).get('locale') === 'en' ? 'en' : 'zh-CN';
localStorage.clear();
localStorage.setItem('atelier.ui-language.v1', locale);
const listeners = new Set();
window.atelierDesktop = {
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async command(projectId) {
    const state = {projectId,tabs:[],activeTabId:null,agentTabId:null,url:'',title:'',control:false,busy:false,transferring:false};
    for (const listener of listeners) listener(state);
  },
  layout() {}
};
await import('/src/main.tsx');
`;

async function focused(locator: Locator) {
  await locator.waitFor({ state: 'visible' });
  await locator.page().waitForFunction(
    (selector) => document.activeElement?.matches(selector),
    await locator.evaluate((element) => {
      element.setAttribute('data-compact-focus-target', 'true');
      return '[data-compact-focus-target="true"]';
    }),
  );
  assert.equal(await locator.evaluate((element) => element === document.activeElement), true);
  await locator.evaluate((element) => element.removeAttribute('data-compact-focus-target'));
}

async function within(locator: Locator, boundary: Locator) {
  const box = await locator.boundingBox();
  const outer = await boundary.boundingBox();
  assert.ok(box && outer);
  assert.ok(
    box.x >= outer.x - 1 && box.x + box.width <= outer.x + outer.width + 1,
    JSON.stringify({ box, outer }),
  );
  assert.ok(
    box.y >= outer.y - 1 && box.y + box.height <= outer.y + outer.height + 1,
    JSON.stringify({ box, outer }),
  );
}

async function screenshot(page: Page, path: string) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.screenshot({ path });
}

async function checkCase(
  application: ElectronApplication,
  page: Page,
  origin: string,
  result: CaseResult,
) {
  const t = labels[result.locale];
  layout = structuredClone(initialWorkspaceLayout);
  sessions = structuredClone(originalSessions);
  await application.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No isolated Electron window');
      window.setContentSize(size.width, size.height);
    },
    { width: result.width, height: result.height },
  );
  await page.goto(
    `${origin}/compact-layout?locale=${result.locale}&size=${result.width}x${result.height}#/sessions/${firstId}`,
  );
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
    width: result.width,
    height: result.height,
  });
  const navigation = page.getByRole('navigation', { name: t.navigation, exact: true });
  const topbar = page.locator('.topbar');
  const footer = navigation.locator('.sidebar-bottom');
  const firstRow = navigation.locator('.history-item').first();
  const firstSession = navigation.locator(`[data-session-node="${firstId}"] .history-item`).first();
  const secondSession = navigation
    .locator(`[data-session-node="${secondId}"] .history-item`)
    .first();
  const otherSession = navigation.locator(`[data-session-node="${otherId}"] .history-item`).first();
  const menu = navigation.getByRole('button', { name: t.menu, exact: true });
  const search = navigation.getByRole('button', { name: t.search, exact: true });
  const input = navigation.getByRole('searchbox', { name: t.search, exact: true });
  const composer = page.locator('#prompt-input');
  await firstRow.waitFor();
  await composer.waitFor();
  const thread = page.getByRole('region', { name: t.currentConversation, exact: true });
  const previewArtifact = thread.getByRole('button', { name: t.previewArtifact, exact: true });
  await previewArtifact.waitFor();
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('.history-item')?.getBoundingClientRect();
    const top = document.querySelector('.topbar')?.getBoundingClientRect();
    const side = document.querySelector('.atelier-sidebar')?.getBoundingClientRect();
    const bottom = document.querySelector('.sidebar-bottom')?.getBoundingClientRect();
    const conversation = document.querySelector('.chat-conversation')?.getBoundingClientRect();
    const composer = document.querySelector('.chat-composer')?.getBoundingClientRect();
    if (!row || !top || !side || !bottom || !conversation || !composer)
      throw new Error('Workspace geometry is missing');
    return {
      firstSessionTop: row.top,
      topbarHeight: top.height,
      sidebarWidth: side.width,
      footerBottom: bottom.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      messageViewportHeight: conversation.height,
      composerBottom: composer.bottom,
    };
  });
  result.measurements = geometry;
  result.conversationRows = await page
    .locator('.conversation-screen')
    .evaluate((element) => getComputedStyle(element).gridTemplateRows);
  result.screenshot = `${result.locale}-${result.width}x${result.height}.png`;
  await screenshot(page, join(evidence, result.screenshot));
  assert.equal(geometry.viewportWidth, result.width);
  assert.equal(geometry.viewportHeight, result.height);
  assert.ok(
    geometry.firstSessionTop <= 110,
    `First session starts at ${geometry.firstSessionTop}px`,
  );
  assert.equal(geometry.topbarHeight, 48);
  assert.ok(result.height - geometry.footerBottom <= 12);
  result.checks.push('first session ≤110px; 48px topbar; footer at window bottom');
  assert.ok(
    geometry.messageViewportHeight >= result.height / 2,
    `Message viewport collapsed to ${geometry.messageViewportHeight}px; rows: ${result.conversationRows}`,
  );
  assert.ok(
    geometry.composerBottom >= result.height - 48,
    `Composer ends at ${geometry.composerBottom}px in a ${result.height}px window`,
  );
  result.checks.push('message viewport uses the available height and composer stays at the bottom');
  const successSummary = thread.locator('.run-summary');
  assert.equal(await successSummary.count(), 1);
  await successSummary.getByText(t.toolSummary, { exact: true }).waitFor();
  assert.equal(await thread.locator('.run-recovery').count(), 0);
  assert.equal(await thread.getByRole('button', { name: t.viewTrace, exact: true }).count(), 1);
  assert.equal(
    await thread.getByRole('button', { name: t.viewTrace, exact: true }).isEnabled(),
    true,
  );
  await within(previewArtifact, thread);
  const download = thread.getByRole('link', { name: t.downloadArtifact, exact: true });
  await download.waitFor();
  assert.equal(await download.getAttribute('href'), `/api/artifacts/${artifact.id}/download`);
  result.checks.push(
    'successful tool receipt has one trace action and no duplicate result card; compact artifact row is visible',
  );

  for (const name of [t.artifacts, t.runs, t.extensions, t.agents, t.settings]) {
    const button = footer.getByRole('button', { name, exact: true });
    await within(button, navigation);
    assert.equal((await button.innerText()).trim(), '', `${name} footer button has visible text`);
    assert.equal(await button.locator('svg').count(), 1);
  }
  assert.equal(
    await footer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await topbar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
  );
  assert.equal(await page.getByRole('heading', { name: longTitle, exact: true }).count(), 1);
  assert.equal(
    await topbar.getByRole('heading', { name: longTitle, exact: true }).getAttribute('title'),
    longTitle,
  );
  result.checks.push(
    'bottom navigation icons have names; long title does not duplicate or overflow',
  );

  const toolbarBefore = await navigation.locator('.sidebar-toolbar').boundingBox();
  await search.click();
  await focused(input);
  const toolbarDuring = await navigation.locator('.sidebar-toolbar').boundingBox();
  assert.deepEqual(toolbarDuring, toolbarBefore, 'Search must replace the existing toolbar row');
  await input.fill('Beta');
  await firstSession.waitFor({ state: 'hidden' });
  await otherSession.waitFor();
  await input.press('Escape');
  await input.waitFor({ state: 'hidden' });
  await focused(search);
  await firstSession.waitFor();
  await search.click();
  assert.equal(await input.inputValue(), '');
  await input.fill('not-a-fixture-session');
  await navigation.getByRole('button', { name: t.closeSearch, exact: true }).click();
  await focused(search);
  await firstSession.waitFor();
  result.checks.push('in-place search autofocus, filtering, Escape/button clear and focus return');

  await menu.click();
  await page.getByRole('menuitem', { name: t.all, exact: true }).waitFor();
  await page.getByRole('menuitem', { name: t.projects, exact: true }).click();
  const projectDialog = page.getByRole('dialog', { name: t.projectDialog, exact: true });
  await projectDialog.waitFor();
  await page.keyboard.press('Escape');
  await projectDialog.waitFor({ state: 'hidden' });
  await topbar.getByRole('button', { name: t.openProjects, exact: true }).click();
  await projectDialog
    .getByRole('button', { name: `${otherProject.name} · ${otherProject.path}`, exact: true })
    .click();
  await projectDialog.waitFor({ state: 'hidden' });
  await topbar.getByText(otherProject.name, { exact: true }).waitFor();
  await menu.waitFor();
  await search.waitFor();
  await secondSession.click();
  await page.waitForURL((url) => url.hash === `#/sessions/${secondId}`);
  await topbar.getByText(firstProject.name, { exact: true }).waitFor();
  const failure = thread.getByRole('region', { name: t.runResult, exact: true });
  assert.ok(failedRun.error);
  await failure.getByText(failedRun.error, { exact: true }).waitFor();
  for (const name of [t.retry, t.viewTrace]) {
    const action = failure.getByRole('button', { name, exact: true });
    await within(action, thread);
    assert.equal(await action.isEnabled(), true);
  }
  if (result.width === 1280)
    await screenshot(page, join(evidence, `${result.locale}-failed-session.png`));
  result.checks.push('failed run retains its error text and enabled retry/trace actions');
  await firstSession.click();
  await page.waitForURL((url) => url.hash === `#/sessions/${firstId}`);
  await footer.getByRole('button', { name: t.runs, exact: true }).click();
  await page.waitForURL((url) => url.hash === '#/runs');
  await menu.click();
  await page.getByRole('menuitem', { name: t.all, exact: true }).click();
  await page.waitForURL((url) => url.hash === `#/sessions/${firstId}`);
  result.checks.push('session/project switching and global navigation preserve entry points');

  await navigation.getByRole('button', { name: t.collapse, exact: true }).click();
  const expand = navigation.getByRole('button', { name: t.expand, exact: true });
  await expand.waitFor();
  await page.waitForFunction(
    () =>
      Math.abs(
        (document.querySelector('.atelier-sidebar')?.getBoundingClientRect().width ?? 0) - 48,
      ) < 1,
  );
  for (const name of [t.artifacts, t.runs, t.extensions, t.agents, t.settings])
    await within(footer.getByRole('button', { name, exact: true }), navigation);
  if (result.width === 1280)
    await screenshot(page, join(evidence, `${result.locale}-collapsed.png`));
  await expand.click();
  await firstSession.waitFor();
  await menu.waitFor();
  result.checks.push('48px collapsed navigation and explicit re-expansion');

  const conversation = topbar.getByRole('tab', { name: t.conversation, exact: true });
  const trace = topbar.getByRole('tab', { name: t.trace, exact: true });
  const artifacts = topbar.getByRole('tab', { name: t.artifacts, exact: true });
  assert.equal(await topbar.getByRole('tab').count(), 3);
  for (const tab of [conversation, trace, artifacts]) await within(tab, topbar);
  await conversation.focus();
  await conversation.press('ArrowRight');
  await page.waitForURL((url) => url.hash === `#/sessions/${firstId}/trace`);
  await focused(trace);
  assert.equal(await trace.getAttribute('aria-selected'), 'true');
  await trace.press('ArrowRight');
  await page.waitForURL((url) => url.hash === `#/sessions/${firstId}/artifacts`);
  await focused(artifacts);
  assert.equal(await artifacts.getAttribute('aria-selected'), 'true');
  await artifacts.press('Home');
  await page.waitForURL((url) => url.hash === `#/sessions/${firstId}`);
  await focused(conversation);
  assert.equal(await conversation.getAttribute('aria-selected'), 'true');
  result.checks.push(
    'three tabs occupy the topbar and support ArrowRight/Home keyboard activation',
  );

  await composer.waitFor();
  assert.equal(await composer.inputValue(), draftText);
  const mode = page.getByRole('combobox', { name: t.mode, exact: true });
  assert.ok((await mode.innerText()).includes(t.readonly));
  await mode.click();
  await page.getByRole('option', { name: new RegExp(`^${t.readonly}`) }).waitFor();
  await page.keyboard.press('Escape');
  await focused(mode);
  const model = page.getByRole('button', { name: t.model, exact: true });
  assert.ok((await model.innerText()).includes(config.model));
  await model.click();
  await page
    .getByRole('combobox', {
      name: result.locale === 'en' ? 'Choose model' : '选择模型',
      exact: true,
    })
    .waitFor();
  await page.keyboard.press('Escape');
  await focused(model);
  for (const name of [t.context, t.upload])
    await page.getByRole('button', { name, exact: true }).waitFor();
  result.checks.push(
    'draft, mode and model survive navigation; menus and composer icon names remain usable',
  );

  for (const name of ['Git', t.terminal, t.browser]) {
    const button = topbar.getByRole('button', { name, exact: true });
    await within(button, topbar);
    assert.equal(await button.isEnabled(), true);
    assert.equal((await button.innerText()).trim(), '');
    await button.focus();
    await focused(button);
  }
  await topbar.getByRole('button', { name: t.terminal, exact: true }).press('Enter');
  await page.waitForURL((url) => url.hash === `#/sessions/${firstId}/terminal`);
  await page.getByRole('button', { name: t.closeTerminal, exact: true }).click();
  assert.equal(new URL(page.url()).hash, `#/sessions/${firstId}/terminal`);
  await focused(topbar.getByRole('button', { name: t.terminal, exact: true }));
  await topbar.getByRole('button', { name: t.browser, exact: true }).press('Enter');
  await page.waitForURL((url) => url.hash === `#/sessions/${firstId}/browser`);
  await page.getByRole('button', { name: t.closeBrowser, exact: true }).click();
  assert.equal(new URL(page.url()).hash, `#/sessions/${firstId}/browser`);
  await focused(topbar.getByRole('button', { name: t.browser, exact: true }));
  result.checks.push(
    'Git/terminal/browser icons are named and keyboard reachable; panel closure restores focus',
  );
  if (result.width === 1280) {
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No isolated Electron window');
      window.setContentSize(800, 800);
    });
    await page.waitForFunction(() => innerWidth === 800 && innerHeight === 800);
    await topbar.getByRole('button', { name: t.browser, exact: true }).click();
    await page.waitForURL((url) => url.hash === `#/sessions/${firstId}/browser`);
    assert.equal(await page.locator('#conversation').getAttribute('inert'), '');
    await page.getByRole('button', { name: t.closeBrowser, exact: true }).waitFor();
    await page
      .getByText(result.locale === 'en' ? 'Opening panel…' : '正在打开面板…', { exact: true })
      .waitFor({ state: 'hidden' });
    await screenshot(page, join(evidence, `${result.locale}-browser-800x800.png`));
    await page.getByRole('button', { name: t.closeBrowser, exact: true }).click();
    assert.equal(new URL(page.url()).hash, `#/sessions/${firstId}/browser`);
    await conversation.waitFor();
    assert.equal(await topbar.getByRole('tab').count(), 3);
    await conversation.focus();
    await conversation.press('ArrowRight');
    await page.waitForURL((url) => url.hash === `#/sessions/${firstId}/trace`);
    await focused(trace);
    await trace.press('Home');
    await page.waitForURL((url) => url.hash === `#/sessions/${firstId}`);
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No isolated Electron window');
      window.setContentSize(1280, 800);
    });
    await page.waitForFunction(() => innerWidth === 1280 && innerHeight === 800);
    result.checks.push(
      '800px browser fills the workspace; collapse restores tabs and keyboard switching',
    );
  }
}

let vite: ViteDevServer | undefined;
let application: ElectronApplication | undefined;
let page: Page | undefined;
let fatal: string | undefined;
let runtime: { electron: string; noSandboxSwitch: boolean } | undefined;
const startedAt = new Date().toISOString();
const before = await sourceDigest();
try {
  vite = await createServer({
    configFile: false,
    envFile: false,
    root: join(root, 'frontend'),
    cacheDir: join(evidenceRoot, 'vite-cache'),
    logLevel: 'error',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'isolated-compact-layout-fixture',
        resolveId(id) {
          if (id === 'virtual:compact-layout') return '\0compact-layout.js';
        },
        load(id) {
          if (id === '\0compact-layout.js') return fixtureEntry;
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.startsWith('/api/')) {
              void fixtureApi(request, response).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                serverErrors.push(message);
                response.statusCode = 500;
                json(response, { error: { message } });
              });
              return;
            }
            if (request.url?.startsWith('/compact-layout')) {
              void server
                .transformIndexHtml(
                  '/compact-layout',
                  '<!doctype html><html><head><meta charset="utf-8"><title>Compact layout fixture</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:compact-layout"></script></body></html>',
                )
                .then((html) => {
                  response.setHeader('Content-Type', 'text/html');
                  response.end(html);
                })
                .catch(next);
              return;
            }
            next();
          });
        },
      },
    ],
    resolve: { alias: { '@': join(root, 'frontend/src'), '@shared': join(root, 'shared') } },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, fs: { allow: [root] } },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const entryPath = join(evidence, 'electron-fixture.mjs');
  await build({
    stdin: {
      contents: `import { app, BrowserWindow, session } from 'electron';
      app.setPath('userData', ${JSON.stringify(join(evidence, 'profile'))});
      void app.whenReady().then(async () => {
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
          const url = new URL(details.url);
          callback({ cancel: !['data:', 'blob:', 'devtools:'].includes(url.protocol) && url.origin !== ${JSON.stringify(origin)} });
        });
        const window = new BrowserWindow({ width:1280, height:800, useContentSize:true, show:true, webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false} });
        await window.loadURL('about:blank');
      });
      app.on('window-all-closed',()=>app.quit());`,
      loader: 'ts',
      resolveDir: root,
    },
    platform: 'node',
    format: 'esm',
    bundle: true,
    external: ['electron'],
    outfile: entryPath,
  });
  application = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron'),
    // Ozone's default 1x1 virtual screen clamps visible windows and prevents useful captures.
    // https://chromium.googlesource.com/chromium/src/+/main/ui/ozone/platform/headless/headless_screen.cc
    args: [
      entryPath,
      '--ozone-platform=headless',
      '--ozone-override-screen-size=2560,1440',
      `--user-data-dir=${join(evidence, 'profile')}`,
    ],
    chromiumSandbox: true,
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' },
    timeout: 15_000,
  });
  runtime = await application.evaluate(({ app }) => {
    return {
      electron: process.versions.electron,
      noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'),
    };
  });
  assert.equal(runtime.noSandboxSwitch, false);
  page = await application.firstWindow();
  page.setDefaultTimeout(8_000);
  page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', (error) => errors.push(error.message));
  for (const locale of ['zh-CN', 'en'] as const) {
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]) {
      const result: CaseResult = { locale, ...size, checks: [] };
      cases.push(result);
      try {
        await checkCase(application, page, origin, result);
      } catch (error) {
        result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
        await screenshot(
          page,
          join(evidence, `${locale}-${size.width}x${size.height}-failure.png`),
        ).catch(() => {});
      }
      console.log(
        `${result.error ? 'FAIL' : 'PASS'} ${locale} ${size.width}x${size.height}: ${result.checks.length} groups${result.error ? ` — ${result.error.split('\n')[0]}` : ''}`,
      );
    }
  }
} catch (error) {
  fatal = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  await application
    ?.close()
    .catch((error: unknown) => errors.push(`Electron cleanup: ${String(error)}`));
  if (vite?.httpServer && 'closeAllConnections' in vite.httpServer)
    vite.httpServer.closeAllConnections();
  await vite?.close();
  await rm(join(evidence, 'profile'), { recursive: true, force: true });
  const after = await sourceDigest();
  const passed =
    !fatal &&
    cases.length === 6 &&
    cases.every((result) => !result.error) &&
    !errors.length &&
    !serverErrors.length &&
    !unexpectedRequests.length &&
    before === after;
  const report = {
    passed,
    startedAt,
    completedAt: new Date().toISOString(),
    sourceDigestBefore: before,
    sourceDigestAfter: after,
    runtime,
    scope:
      'Real frontend and sandboxed Electron renderer; synthetic HTTP/native browser bridge; no production main, model, PTY or user data.',
    cases,
    errors,
    serverErrors,
    unexpectedRequests,
    requests,
    fatal,
  };
  await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    join(evidenceRoot, 'latest.json'),
    `${JSON.stringify({ evidence: relative(root, evidence), passed }, null, 2)}\n`,
  );
  console.log(
    `Compact layout ${passed ? 'passed' : 'failed'}; evidence: ${relative(root, evidence)}/result.json`,
  );
  if (!passed) process.exitCode = 1;
}
