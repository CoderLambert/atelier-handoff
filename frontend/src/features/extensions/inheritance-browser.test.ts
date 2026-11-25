/**
 * @file 验证 Skill 继承设置和会话草稿的浏览器交互。
 * @implementation 使用 Chromium、合成页面和本地替身接口检查策略操作、草稿选择及语言切换。
 * @updated 2026-11-26T00:06:59+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { SkillInheritanceItem, SkillInheritancePatch } from '@shared/skill-inheritance';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

const host: SkillInheritanceItem = {
  id: '90000000-0000-4000-8000-000000000001',
  name: 'fixture-notes',
  description: 'Synthetic Skill',
  version: 2,
  source: 'host',
  mode: 'off',
  effective: 'off',
  override: 'follow',
  manual: true,
  auto: true,
};
const missing = '90000000-0000-4000-8000-000000000002';

async function fixtureBundle() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const compiled = await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { uiI18n } from '@/i18n';
        import { Composer } from '@/features/chat/composer';
        import ExtensionsPage from '@/features/extensions';
        const project = {id:'alpha', name:'Fixture project', path:'/mock', available:true};
        const snapshot = {project, session:{id:'session-alpha',status:'active'}, messages:[], attachments:[],
          runs:[{id:'active',status:'running',startedAt:'2026-11-25T00:00:00Z',config:{},extensions:[{id:${JSON.stringify(host.id)},name:'fixture-notes',kind:'skill',version:2}]}]};
        function App() {
          const [draft, setDraft] = useState({mode:'edit', text:'Keep original text', contextPaths:[], attachmentIds:[],
            executionPreference:'native-v1',extensionSelections:[{id:${JSON.stringify(missing)},version:1}]});
          const [sent, setSent] = useState(0);
          return <>
            <ExtensionsPage projects={[project]}/>
            <button type="button" onClick={() => setDraft(d => ({...d, executionPreference:'project-v1'}))}>Controlled fixture mode</button>
            <button type="button" onClick={() => void uiI18n.changeLanguage('zh-CN')}>中文</button>
            <Composer snapshot={snapshot} draft={draft} nativeExecution submitting={false}
              defaultModel="fixture" onDraftChange={setDraft} onRemoveQuote={() => {}} onModeChange={() => {}}
              onModelChange={() => {}} onEffortChange={() => {}} onStop={() => {}}
              onSend={async () => setSent(s => s + 1)}/>
            <output id="draft">{JSON.stringify(draft)}</output><output id="sent">{sent}</output>
          </>;
        }
        uiI18n.changeLanguage('en').then(() => createRoot(document.getElementById('app')).render(
          <QueryClientProvider client={new QueryClient()}><App /></QueryClientProvider>));
      `,
    },
    tsconfig: `${root}/tsconfig.json`,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    loader: { '.css': 'empty' },
  });
  const bundle = compiled.outputFiles[0]?.text;
  assert.ok(bundle);
  return bundle;
}

test(
  'inheritance controls preserve project actions and update only explicit draft choices',
  { skip: !browserPath, timeout: 45_000 },
  async () => {
    const bundle = await fixtureBundle();
    let enabled = false;
    let mode: SkillInheritanceItem['mode'] = 'off';
    let projectMode: 'follow' | 'block' = 'follow';
    let override: SkillInheritanceItem['override'] = 'follow';
    let failOnce = true;
    const mutations: { scope: string; patch: SkillInheritancePatch }[] = [];
    const queries: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      function json(value: unknown, status = 200) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      }
      if (url.pathname === '/bundle.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        response.end(bundle);
      } else if (url.pathname === '/api/skill-inheritance') {
        if (request.method === 'PATCH') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const patch: SkillInheritancePatch = JSON.parse(body);
          mutations.push({ scope: url.search, patch });
          if (patch.type === 'global') enabled = patch.enabled;
          if (patch.type === 'host') mode = patch.mode;
          if (patch.type === 'project') projectMode = patch.mode;
          if (patch.type === 'session') {
            if (failOnce) {
              failOnce = false;
              json({ error: { code: 'CONFLICT' } }, 409);
              return;
            }
            override = patch.mode;
          }
        } else {
          queries.push(url.search);
        }
        const session = url.searchParams.has('sessionId');
        const global = !session && !url.searchParams.has('projectId');
        const reason = !enabled
          ? 'global-off'
          : !global && projectMode === 'block'
            ? 'project-blocked'
            : session && !url.searchParams.has('native')
              ? 'not-native'
              : mode === 'off'
                ? 'disabled'
                : session && override === 'off'
                  ? 'session-off'
                  : undefined;
        const item: SkillInheritanceItem = {
          ...host,
          mode,
          effective: reason ? 'off' : session && override === 'manual' ? 'manual' : mode,
          override: session ? override : 'follow',
          reason,
        };
        json({ enabled, projectMode, items: [item] });
      } else if (url.pathname === '/api/bootstrap') {
        json({ csrfToken: 'fixture-only', config: { gateway: 'http://localhost:1' } });
      } else if (url.pathname === '/api/config') {
        json({ config: { gateway: 'http://localhost:1' } });
      } else if (url.pathname.startsWith('/api/')) {
        json({ items: [] });
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          '<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/bundle.js"></script>',
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      chromiumSandbox: true,
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      for (const name of ['Skill market', 'Import from a public source', 'Import Markdown']) {
        await page.getByRole('button', { name, exact: true }).waitFor();
      }
      const project = page.getByRole('combobox', { name: 'Local inheritance for this project' });
      await project.click();
      await page.getByRole('option', { name: 'Block for this project' }).click();
      await project.getByText('Block for this project').waitFor();
      await project.click();
      await page.getByRole('option', { name: 'Follow global policy' }).click();
      await project.getByText('Follow global policy').waitFor();
      await page.getByRole('button', { name: 'Local inheritance', exact: true }).click();
      const master = page.getByRole('switch', { name: 'Inherit local Skills' });
      await master.waitFor();
      assert.equal(await master.isChecked(), false);
      const hostPolicy = page.getByRole('combobox', { name: 'Global policy for fixture-notes' });
      await hostPolicy.click();
      await page.getByRole('option', { name: 'Manual only' }).click();
      await hostPolicy.getByText('Manual only').waitFor();
      await page.getByText('Global inheritance is off.', { exact: true }).waitFor();
      assert.equal(await master.isChecked(), false);
      await master.press('Space');
      await page.waitForFunction(() => document.querySelector('[role="switch"]:checked') !== null);
      assert.deepEqual(mutations.slice(0, 4), [
        { scope: '?projectId=alpha', patch: { type: 'project', mode: 'block' } },
        { scope: '?projectId=alpha', patch: { type: 'project', mode: 'follow' } },
        { scope: '', patch: { type: 'host', id: host.id, mode: 'manual' } },
        { scope: '', patch: { type: 'global', enabled: true } },
      ]);
      const trigger = page.getByRole('button', { name: 'Session Skills' });
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Session Skills' });
      await dialog.getByText('Recorded on active run').waitFor();
      await dialog.getByText('Draft Skills no longer listed').waitFor();
      await dialog.getByRole('button', { name: `Remove ${missing} from draft` }).click();
      const add = dialog.getByRole('button', {
        name: 'Add fixture-notes (Local user directory) to draft',
      });
      await add.click();
      assert.deepEqual(
        JSON.parse((await page.locator('#draft').textContent()) ?? '{}').extensionSelections,
        [{ id: host.id, version: 2 }],
      );
      assert.equal(await page.locator('#sent').textContent(), '0');
      assert.equal(await page.locator('#prompt-input').inputValue(), 'Keep original text');
      const restriction = dialog.getByRole('combobox', {
        name: /Session restriction for fixture-notes/,
      });
      await restriction.click();
      await page.getByRole('option', { name: 'Off', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      await restriction.getByText('Follow parent policy').waitFor();
      await restriction.click();
      await page.getByRole('option', { name: 'Off', exact: true }).click();
      await dialog.getByText('Disabled for this session.').waitFor();
      await dialog
        .getByRole('button', { name: 'Remove fixture-notes (Local user directory) from draft' })
        .click();
      assert.deepEqual(
        JSON.parse((await page.locator('#draft').textContent()) ?? '{}').extensionSelections,
        [],
      );
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      await page.getByRole('button', { name: 'Controlled fixture mode' }).click();
      await trigger.click();
      await dialog.getByText('Available only in Native trust mode.').waitFor();
      assert.equal(await restriction.isDisabled(), true);
      assert.equal(await add.count(), 0);
      assert.ok(queries.includes('?sessionId=session-alpha&native=1'));
      assert.ok(queries.includes('?sessionId=session-alpha'));
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '中文', exact: true }).click();
      await page.getByRole('button', { name: '本会话 Skills' }).click();
      await page
        .getByRole('dialog', { name: '本会话 Skills' })
        .getByText('仅在本机信任模式下可用。')
        .waitFor();
      assert.equal(await page.locator('#sent').textContent(), '0');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
