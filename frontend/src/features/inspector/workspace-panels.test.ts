/**
 * @file 验证浏览器与终端面板的工作区交互。
 * @implementation 使用合成快照、隔离 Chromium 和原生桥替身检查面板布局、路由返回、尺寸隔离、焦点及弹窗遮挡，不启动 Electron 或读取用户数据。
 * @updated 2026-11-26T04:17:21+08:00
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Bootstrap, Snapshot } from '@/api/types';
import { initialWorkspaceLayout, type WorkspaceLayout } from '@shared/workspace-layout';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const projectId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const runId = '33333333-3333-4333-8333-333333333333';
const at = '2026-11-22T10:00:00.000Z';
const sessionPath = `/sessions/${sessionId}`;
const tracePath = `${sessionPath}/trace/${runId}`;
const value: Snapshot = {
  session: {
    id: sessionId,
    projectId,
    title: '布局测试会话',
    status: 'active',
    sdkSessionId: null,
    createdAt: at,
    updatedAt: at,
    draft: { text: '', mode: 'readonly', contextPaths: [], attachmentIds: [] },
  },
  project: {
    id: projectId,
    name: '布局测试项目',
    path: '/fixture/project',
    branch: 'fixture',
    available: true,
    createdAt: at,
  },
  runs: [
    {
      id: runId,
      sessionId,
      projectId,
      prompt: '合成任务',
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
      config: { gateway: 'http://fixture.test', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
    },
  ],
  messages: [],
  tools: [],
  permissions: [],
  artifacts: [],
  attachments: [],
  events: [],
  cursor: 0,
};
const ready: Bootstrap = {
  csrfToken: 'fixture',
  cursor: 0,
  projects: [value.project],
  sessions: [value.session],
  runs: value.runs,
  artifacts: [],
  config: value.runs[0]!.config,
  capabilities: { commands: false },
  connection: { available: true, message: 'fixture' },
};

test(
  'workspace reserves the right pane for an explicitly opened browser and preserves routes, sizes and native slots',
  { skip: !browserPath, timeout: 60000 },
  async (context) => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {Provider} from 'react-redux';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {RouterProvider} from '@tanstack/react-router';
      import {workspaceRouter} from '@/app/workspace-router';
      import {store} from '@/app/store';
      window.fixtureRouter = workspaceRouter;
      window.nativeLayouts = [];
      if (!new URLSearchParams(location.search).has('web')) {
        let listener;
        window.atelierDesktop = {
          subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
          async command(projectId) { listener?.({projectId,tabs:[],activeTabId:null,agentTabId:null,url:'',title:'',control:false,busy:false,transferring:false}); },
          layout(projectId, bounds) { window.nativeLayouts.push({projectId,bounds}); }
        };
      }
      const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
      createRoot(document.getElementById('root')).render(<Provider store={store}><QueryClientProvider client={client}><RouterProvider router={workspaceRouter}/></QueryClientProvider></Provider>);
    `,
      },
      tsconfig: `${root}/tsconfig.json`,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      loader: { '.css': 'empty' },
      alias: {
        '@atelier/markdown': `${root}/../packages/markdown/src/index.tsx`,
        '@atelier/markdown/style.css': `${root}/../packages/markdown/src/style.css`,
      },
      plugins: [
        {
          name: 'isolate-session-chat',
          setup(builder) {
            builder.onLoad({ filter: /\/app\/session-chat\.tsx$/ }, () => ({
              loader: 'tsx',
              contents: `import React from 'react'; export default function SessionChat(){return <div aria-label="模拟会话">合成聊天内容</div>;}`,
            }));
          },
        },
      ],
    });
    const bundle = compiled.outputFiles[0]?.text;
    assert.ok(bundle);
    const css = await compile(
      `@import "./app/sidebar.css";\n${readFileSync(`${root}/src/styles.css`, 'utf8')}`,
      {
        base: `${root}/src`,
        onDependency() {},
      },
    );
    const styles = css.build(
      [
        'app/workspace.tsx',
        'app/workspace-panels.tsx',
        'features/inspector/index.tsx',
        'features/inspector/run-trace.tsx',
        'components/ui/button.tsx',
        'components/ui/dialog.tsx',
      ].flatMap((path) => readFileSync(`${root}/src/${path}`, 'utf8').split(/[\s"'`{}<>]/)),
    );
    let layout: WorkspaceLayout = structuredClone(initialWorkspaceLayout);
    let previewRequests = 0;
    const layoutWrites: WorkspaceLayout[] = [];
    const unexpected: string[] = [];
    const server = createServer(async (req, res) => {
      const path = req.url ?? '/';
      if (path === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return void res.end(bundle);
      }
      if (path.startsWith('/api/')) {
        if (path.startsWith('/api/events')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(': fixture\n\n');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        if (path === '/api/bootstrap') return void res.end(JSON.stringify(ready));
        if (path === '/api/terminals/capabilities')
          return void res.end(
            JSON.stringify({
              supported: false,
              reason: 'desktop-required',
              runtimeId: '44444444-4444-4444-8444-444444444444',
              shellName: null,
              protocolVersion: 1,
              limits: { perRuntime: 8, perSession: 4 },
            }),
          );
        if (path === `/api/sessions/${sessionId}`) return void res.end(JSON.stringify(value));
        if (path === `/api/runs/${runId}/trace`)
          return void res.end(JSON.stringify({ events: [], eventCount: 0 }));
        if (path.startsWith('/api/runs?'))
          return void res.end(JSON.stringify({ items: [], total: 0, nextOffset: null }));
        if (path === `/api/projects/${projectId}/desktop-browser`)
          return void res.end(JSON.stringify({ enabled: false, available: true, revision: null }));
        if (path.startsWith(`/api/projects/${projectId}/browser-preview`)) {
          previewRequests++;
          return void res.end(JSON.stringify({ frame: null }));
        }
        if (path === '/api/settings/workspace-layout') {
          if (req.method === 'PATCH') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            layout = JSON.parse(Buffer.concat(chunks).toString()) as WorkspaceLayout;
            layoutWrites.push(layout);
          }
          return void res.end(JSON.stringify(layout));
        }
        if (path === '/api/settings/workspace-location') return void res.end('{}');
        unexpected.push(`${req.method} ${path}`);
        res.statusCode = 404;
        return void res.end(JSON.stringify({ error: { message: `Unexpected fixture ${path}` } }));
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${styles}</style></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,
      );
    });
    context.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/#${tracePath}`);
      await page.getByRole('region', { name: '运行执行轨迹', exact: true }).waitFor();
      const browserButton = page.getByRole('button', { name: '浏览器', exact: true });
      const splitter = page.getByRole('separator', { name: '调整浏览器宽度', exact: true });
      const panel = page.getByRole('region', { name: '浏览器面板', exact: true });
      async function fullCenter() {
        await splitter.waitFor({ state: 'detached' });
        await panel.waitFor({ state: 'detached' });
        assert.equal(await splitter.count(), 0);
        assert.equal(await panel.count(), 0);
        // Read both rectangles in one frame: a resize may restore saved pixels
        // between separate browser calls.
        const geometry = await page.locator('.main').evaluate((element) => {
          const navigation = document.querySelector('nav[aria-label="工作空间导航"]');
          if (!navigation) return undefined;
          return {
            navigation: navigation.getBoundingClientRect().width,
            center: element.getBoundingClientRect().width,
            viewport: innerWidth,
          };
        });
        assert.ok(geometry);
        assert.ok(
          Math.abs(geometry.center - (geometry.viewport - geometry.navigation - 8)) < 2,
          JSON.stringify(geometry),
        );
      }
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        await page.setViewportSize(viewport);
        await fullCenter();
      }
      assert.equal(await page.getByRole('button', { name: '任务详情', exact: true }).count(), 0);
      assert.equal(await page.getByRole('heading', { name: '工作详情', exact: true }).count(), 0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await browserButton.click();
      await splitter.waitFor();
      await page.getByRole('region', { name: '桌面浏览器', exact: true }).waitFor();
      assert.equal(new URL(page.url()).hash, `#${sessionPath}/browser`);
      assert.equal(
        await page.getByRole('tab', { name: /^执行轨迹/ }).getAttribute('aria-selected'),
        'true',
      );
      await page.waitForFunction(
        () => Reflect.get(window, 'nativeLayouts').at(-1)?.bounds?.width > 0,
      );
      const before = await panel.boundingBox();
      assert.ok(before && Math.abs(before.width - 320) < 2);
      const topbar = await page.locator('.topbar').boundingBox();
      const tabs = await panel.locator('.desktop-browser-tabbar').boundingBox();
      assert.ok(topbar && tabs);
      assert.equal(topbar.height, 48);
      assert.equal(tabs.height, 48);
      assert.equal(tabs.y + tabs.height, topbar.y + topbar.height);
      assert.equal(await panel.locator('.workspace-browser-heading').count(), 0);
      const resized = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/settings/workspace-layout') &&
          response.request().method() === 'PATCH',
      );
      await splitter.press('ArrowLeft');
      await resized;
      await page.waitForFunction(
        () => Reflect.get(window, 'nativeLayouts').at(-1)?.bounds?.width > 325,
      );
      assert.ok(layout.recent.right > 320);
      const savedRight = layout.recent.right;
      const writesAfterResize = layoutWrites.length;
      await page.locator('.topbar').getByRole('button', { name: '终端', exact: true }).click();
      await page.waitForURL((url) => url.hash === `#${sessionPath}/terminal`);
      await page.waitForFunction(
        () => Reflect.get(window, 'nativeLayouts').at(-1)?.bounds === null,
      );
      await browserButton.click();
      await panel.waitFor();
      await page.getByRole('button', { name: '关闭浏览器', exact: true }).click();
      await page.waitForURL((url) => url.hash === `#${tracePath}`);
      assert.equal(
        await browserButton.evaluate((element) => element === document.activeElement),
        true,
      );
      await fullCenter();
      await page.getByRole('button', { name: '工作台前进', exact: true }).click();
      await splitter.waitFor();
      await page.waitForFunction(
        (width) =>
          Math.abs(
            (document.querySelector('.react-side')?.getBoundingClientRect().width ?? 0) - width,
          ) < 2,
        savedRight,
      );
      assert.equal(layoutWrites.length, writesAfterResize);
      const changeButton = { name: '变更记录', exact: true };
      assert.equal(await page.locator('.topbar').getByRole('button', changeButton).count(), 0);
      const changes = page
        .getByRole('tabpanel', { name: /^执行轨迹/ })
        .getByRole('button', changeButton);
      const sessionTabs = await page.locator('.session-tabs').boundingBox();
      const changesBounds = await changes.boundingBox();
      assert.ok(
        sessionTabs && changesBounds && changesBounds.y >= sessionTabs.y + sessionTabs.height,
      );
      await changes.click();
      const dialog = page.getByRole('dialog', { name: '变更记录', exact: true });
      await dialog.getByText('暂无操作记录。', { exact: true }).waitFor();
      const drawer = await dialog.boundingBox();
      assert.ok(drawer);
      assert.equal(drawer.y, 0);
      assert.equal(drawer.height, 900);
      assert.equal(drawer.width, 480);
      assert.equal(drawer.x + drawer.width, 1440);
      await page.waitForFunction(
        () => Reflect.get(window, 'nativeLayouts').at(-1)?.bounds === null,
      );
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        () => Reflect.get(window, 'nativeLayouts').at(-1)?.bounds?.width > 0,
      );
      assert.equal(await changes.evaluate((element) => element === document.activeElement), true);
      for (const viewport of [
        { width: 1000, height: 800 },
        { width: 900, height: 800 },
        { width: 800, height: 800 },
        { width: 700, height: 800 },
      ]) {
        await page.setViewportSize(viewport);
        await splitter.waitFor({ state: viewport.width < 900 ? 'detached' : 'visible' });
        await panel.waitFor({ state: 'visible' });
        await page.waitForFunction(() => {
          const sent = Reflect.get(window, 'nativeLayouts').at(-1)?.bounds;
          const slot = document.querySelector('.desktop-browser-slot')?.getBoundingClientRect();
          return (
            sent &&
            slot &&
            slot.height > 0 &&
            Math.abs(sent.width - slot.width) < 2 &&
            Math.abs(sent.x - slot.x) < 2
          );
        });
        assert.equal(await panel.count(), 1);
        assert.equal(await page.getByRole('dialog').count(), 0);
        if (viewport.width < 900) {
          const geometry = await panel.evaluate((element) => ({
            panel: element.getBoundingClientRect().width,
            center: document.querySelector('.main')?.getBoundingClientRect().width,
          }));
          assert.ok(geometry.center);
          assert.ok(Math.abs(geometry.panel - geometry.center) < 2);
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(
          await page
            .locator('.topbar')
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
        );
      }
      await page.getByRole('button', { name: '关闭浏览器', exact: true }).click();
      await page.waitForURL((url) => url.hash === `#${tracePath}`);
      await page.getByRole('tab', { name: '会话', exact: true }).click();
      await browserButton.click();
      await panel.waitFor();
      await page.reload();
      await panel.waitFor();
      await page.getByRole('button', { name: '关闭浏览器', exact: true }).click();
      await page.waitForURL((url) => url.hash === `#${sessionPath}`);
      await page.goto(`http://127.0.0.1:${address.port}/#${sessionPath}/browser`);
      await panel.waitFor();
      await page.getByRole('button', { name: '关闭浏览器', exact: true }).click();
      await page.waitForURL((url) => url.hash === `#${sessionPath}`);
      await page.goto(`http://127.0.0.1:${address.port}/?web#${sessionPath}`);
      await browserButton.waitFor();
      assert.equal(previewRequests, 0);
      const previewResponse = page.waitForResponse((response) =>
        response.url().includes('/browser-preview'),
      );
      await browserButton.click();
      await previewResponse;
      await page.getByRole('region', { name: '浏览器实时预览', exact: true }).waitFor();
      assert.ok(previewRequests > 0);
      const previewCount = previewRequests;
      await page.getByRole('button', { name: '关闭浏览器', exact: true }).click();
      await page
        .getByRole('region', { name: '浏览器实时预览', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(previewRequests, previewCount);
      await page.setViewportSize({ width: 1440, height: 900 });
      const terminalButton = page
        .locator('.topbar')
        .getByRole('button', { name: '终端', exact: true });
      await terminalButton.click();
      await page.waitForURL((url) => url.hash === `#${sessionPath}/terminal`);
      await page.getByText('终端仅在已配对的桌面应用中可用。', { exact: true }).waitFor();
      assert.equal(
        layout.recent.right,
        savedRight,
        'Terminal must not overwrite the Browser width',
      );
      await page.reload();
      await page.getByText('终端仅在已配对的桌面应用中可用。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '收起终端面板', exact: true }).click();
      await page.waitForURL((url) => url.hash === `#${sessionPath}`);
      assert.equal(
        await terminalButton.evaluate((element) => element === document.activeElement),
        true,
      );
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
