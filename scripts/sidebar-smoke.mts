import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright-core';
import { createServer, transformWithOxc } from 'vite';

// This fixture has no runtime: all sessions and query data exist only in its browser context.
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = `
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from '@/app/sidebar';
import { actions, store } from '@/app/store';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import '@/styles.css';

const projects = ['Alpha', 'Beta'].map((name, i) => ({ id: name, name, path: '/tmp/sidebar-' + name, branch: 'main', available: true, createdAt: '2026-11-01' }));
const make = (id, projectId, title, fork) => ({ id, projectId, title, fork, status: 'active', sdkSessionId: null, createdAt: '2026-11-20', updatedAt: '2026-11-20', draft: { text: '', mode: 'readonly', attachmentIds: [], contextPaths: [] } });
const initial = [
  make('a', 'Alpha', 'Alpha source'),
  make('a-branch', 'Alpha', 'Needle branch', { sourceSessionId: 'a', sourceMessageId: 'origin', sourceTitle: 'Alpha source' }),
  make('a-head', 'Alpha', 'Restarted head', { sourceSessionId: 'a-branch', sourceMessageId: 'origin', sourceTitle: 'Needle branch', kind: 'rewind' }),
  make('b', 'Beta', 'Beta other row'),
  make('b-long', 'Beta', '会话详情与验证记录：' + '这是一段需要保持单行显示的长会话标题'.repeat(4)),
  { ...make('b-archive', 'Beta', 'Beta archived'), status: 'archived' },
  make('orphan', 'removed', 'Missing project history'),
];
const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
for (const status of ['queued', 'running', 'awaiting_permission', 'stopping']) {
  client.setQueryData(['runs', { projectId: '', sessionId: '', status, limit: 500, offset: 0 }], {
    items: status === 'awaiting_permission' ? [{ id: 'fake-run', sessionId: 'a-head', status }] : [], total: 0,
  });
}
function Fixture() {
  const [sessions, setSessions] = useState(initial);
  const [collapsed, setCollapsed] = useState(false);
  const [current, setCurrent] = useState('a');
  const [view, setView] = useState('chat');
  const [action, setAction] = useState('');
  const [dialog, setDialog] = useState();
  const [created, setCreated] = useState('');
  const dialogOpener = useRef(null);
  return <div style={{ display: 'flex', height: '100dvh' }}>
    <div id="fixture-sidebar" style={{ width: collapsed ? 48 : 232, flex: 'none' }}>
      <Sidebar current={current} view={view} projects={projects} project={projects[0]} sessions={sessions} sessionsFailed={false}
        onRetrySessions={() => {}} onSession={setCurrent}
        onView={setView} onNew={() => setCreated('global')}
        onNewProject={setCreated} onProjects={() => {}} onSettings={() => {}}
        collapsed={collapsed} onToggleCollapsed={() => setCollapsed((value) => !value)}
        onSessionAction={(type, session) => {
          setAction(type + ':' + session.id);
          if (type === 'archive' || type === 'restore') setSessions((entries) => entries.map((entry) => entry.id === session.id ? { ...entry, status: type === 'archive' ? 'archived' : 'active' } : entry));
          else { dialogOpener.current = document.activeElement; setDialog({ type, session }); }
        }} />
    </div>
    <main style={{ padding: 24 }}>
      <output id="fixture-action">{action}</output><output id="fixture-created">{created}</output>
      <button id="fixture-select-branch" onClick={() => setCurrent('a-branch')}>Select nested branch</button>
      <Dialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(undefined); }}>
        <DialogContent onCloseAutoFocus={(event) => { event.preventDefault(); dialogOpener.current?.focus(); }}><DialogTitle>{dialog?.type === 'delete' ? '删除测试会话' : '重命名测试会话'}</DialogTitle><DialogDescription>{dialog?.session.title}</DialogDescription><label>会话标题<input aria-label="会话标题" defaultValue={dialog?.session.title} /></label><button onClick={() => setDialog(undefined)}>取消</button></DialogContent>
      </Dialog>
    </main>
  </div>;
}
createRoot(document.getElementById('root')).render(<Provider store={store}><QueryClientProvider client={client}><Fixture /></QueryClientProvider></Provider>);
`;

const server = await createServer({
  configFile: false,
  root: `${root}frontend`,
  logLevel: 'error',
  plugins: [
    tailwindcss(),
    {
      name: 'isolated-sidebar-fixture',
      resolveId(id) {
        if (id === 'virtual:sidebar-fixture') return '\0sidebar-fixture.tsx';
      },
      async load(id) {
        if (id === '\0sidebar-fixture.tsx')
          return (
            await transformWithOxc(fixture, 'sidebar-fixture.tsx', {
              lang: 'tsx',
              jsx: { runtime: 'automatic' },
            })
          ).code;
      },
      configureServer(vite) {
        vite.middlewares.use('/sidebar-fixture', (_request, response) => {
          void vite
            .transformIndexHtml(
              '/sidebar-fixture',
              '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Sidebar fixture</title></head><body><div id="root"></div><script type="module" src="/@id/virtual:sidebar-fixture"></script></body></html>',
            )
            .then((html) => {
              response.setHeader('Content-Type', 'text/html');
              response.end(html);
            });
        });
      },
    },
  ],
  resolve: { alias: { '@': `${root}frontend/src`, '@shared': `${root}shared` } },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
});
await server.listen();
let browser;
try {
  const address = server.httpServer?.address();
  assert(address && typeof address !== 'string');
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).pathname.startsWith('/api/') ? route.abort() : route.continue(),
  );
  await page.goto(`http://127.0.0.1:${address.port}/sidebar-fixture`);
  const nav = page.getByRole('navigation', { name: '工作空间导航' });
  await nav.waitFor();
  assert.equal(await page.locator('[data-project-id="Alpha"] [data-session-node="b"]').count(), 0);
  assert.equal(await page.locator('[data-project-id="Beta"] [data-session-node="a"]').count(), 0);
  assert.equal(await nav.getByText('Missing project history', { exact: true }).count(), 1);
  assert.equal(await nav.getByText('等待审批', { exact: true }).count(), 1);
  const longRow = nav.locator('[data-session-node="b-long"] .sidebar-session-row');
  const longTitle = longRow.locator('.history-title');
  assert.ok(await longTitle.evaluate((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).textOverflow === 'ellipsis'));
  assert.equal(await longTitle.getAttribute('title'), await longTitle.textContent());
  const rowBounds = await longRow.boundingBox();
  const rowMenu = await longRow.locator('.sidebar-session-menu-trigger').boundingBox();
  assert.ok(rowBounds && rowMenu && rowBounds.height <= 48);
  assert.ok(rowMenu.y >= rowBounds.y && rowMenu.y + rowMenu.height <= rowBounds.y + rowBounds.height);
  assert.ok(rowMenu.x >= rowBounds.x + rowBounds.width - 32);
  await nav.getByRole('button', { name: '在「Beta」中新建会话' }).click();
  assert.equal(await page.locator('#fixture-created').textContent(), 'Beta');

  const otherMenu = nav.getByRole('button', { name: '管理会话「Beta other row」' });
  await otherMenu.focus();
  assert.equal(await otherMenu.evaluate((element) => getComputedStyle(element).opacity), '1');
  await otherMenu.press('ArrowDown');
  const menu = page.getByRole('menu');
  await menu.waitFor();
  const menuBounds = await menu.boundingBox();
  const navBounds = await nav.boundingBox();
  assert(
    menuBounds &&
      navBounds &&
      menuBounds.x >= navBounds.x &&
      menuBounds.x + menuBounds.width <= navBounds.x + navBounds.width,
    'menu stays within the visible sidebar',
  );
  if (process.env.ATELIER_SIDEBAR_SCREENSHOT)
    await nav.screenshot({ path: process.env.ATELIER_SIDEBAR_SCREENSHOT });
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === '管理会话「Beta other row」',
  );
  assert.equal(
    await page
      .locator('[aria-current="page"].history-item')
      .textContent()
      .then((value) => value?.includes('Alpha source')),
    true,
  );
  await otherMenu.click();
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('#fixture-action')?.textContent === 'archive:b',
  );
  assert.equal(await page.locator('[data-session-node="b"] .history-meta').textContent(), '已归档');
  assert.equal(
    await page
      .locator('[aria-current="page"].history-item')
      .textContent()
      .then((value) => value?.includes('Alpha source')),
    true,
    'managing another session preserves the current session',
  );
  await otherMenu.click();
  await page.getByRole('menuitem', { name: '恢复会话', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('#fixture-action')?.textContent === 'restore:b',
  );
  await otherMenu.click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('textbox', { name: '会话标题' }).waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === '会话标题',
  );
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === '管理会话「Beta other row」',
  );
  await otherMenu.click();
  await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await nav.getByText('Beta other row', { exact: true }).count(), 1);

  const search = nav.getByRole('searchbox', { name: '搜索项目或会话' });
  await search.fill('Needle');
  assert.equal(await page.locator('.sidebar-project').count(), 1);
  assert.equal(await nav.getByText('Restarted head', { exact: true }).count(), 1);
  assert.equal(await nav.getByText('Alpha source', { exact: true }).count(), 1);
  assert.equal(
    await page
      .locator('[data-session-node="a-branch"] .history-meta')
      .textContent()
      .then((value) => value?.includes('回退前')),
    true,
  );
  await search.fill('Beta');
  assert.equal(await page.locator('.sidebar-project').count(), 1);
  assert.equal(await nav.getByText('Beta archived', { exact: true }).count(), 1);
  await search.fill('');
  await page.locator('[data-project-id="Alpha"] .sidebar-project-toggle').click();
  assert.equal(await nav.getByText('Needle branch', { exact: true }).isVisible(), false);
  await page.locator('#fixture-select-branch').click();
  assert.equal(await nav.getByText('Needle branch', { exact: true }).isVisible(), true);
  await nav.getByRole('button', { name: '收起侧栏', exact: true }).click();
  assert.equal((await nav.boundingBox())?.width, 48);
  assert.equal(
    await nav.getByRole('button', { name: '工作台设置', exact: true }).isVisible(),
    true,
  );
  assert.equal(await nav.getByRole('button', { name: '全部会话', exact: true }).isVisible(), true);
  assert.equal(
    await nav.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    'collapsed rail has no horizontal overflow',
  );
  await nav.getByRole('button', { name: '展开侧栏', exact: true }).click();
  assert.equal(await nav.getByText('Needle branch', { exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(
    'Sidebar smoke passed: project grouping, rewind search, project creation, non-current archive/restore, delete cancel, keyboard menu focus, dialog focus, menu bounds, auto reveal, 48px rail.',
  );
} finally {
  await browser?.close();
  await server.close();
}
