/**
 * @file 验证 Hooks 页的 RTK 设置双语交互。
 * @implementation 用 Chromium 和本地接口替身覆盖标签键盘、保存失败、继承撤回、项目切换及能力不可用提示。
 * @updated 2026-11-26T01:39:35+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import {
  rtkSettingsPatchSchema,
  type RtkProjectMode,
  type RtkSettingsView,
} from '@shared/rtk-settings';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

test(
  'Hooks settings expose reversible global/project choices and localized failure/reload states',
  { skip: !browserPath, timeout: 45_000 },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { uiI18n } from '@/i18n';
      import ExtensionsPage from '@/features/extensions';
      const projects = ['alpha','beta'].map(id => ({id,name:id,path:'/fixture/'+id,available:true}));
      uiI18n.changeLanguage('en').then(() => createRoot(document.getElementById('app')).render(
        <QueryClientProvider client={new QueryClient()}>
          <button onClick={() => void uiI18n.changeLanguage('zh-CN')}>中文</button>
          <ExtensionsPage projects={projects} />
        </QueryClientProvider>));
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
    let globalEnabled = true;
    let available = true;
    let failSave = true;
    let failRead = false;
    const modes = new Map<string, RtkProjectMode>();
    const writes: { projectId: string | null; type: string }[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      function json(value: unknown, status = 200) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      }
      if (url.pathname === '/bundle.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        response.end(bundle);
      } else if (url.pathname === '/api/rtk-settings') {
        const projectId = url.searchParams.get('projectId');
        if (request.method === 'PATCH') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const patch = rtkSettingsPatchSchema.parse(JSON.parse(body));
          writes.push({ projectId, type: patch.type });
          if (failSave) {
            failSave = false;
            json({ error: { code: 'CONFLICT' } }, 409);
            return;
          }
          if (patch.type === 'global') globalEnabled = patch.enabled;
          else if (projectId) modes.set(projectId, patch.mode);
        } else if (failRead) {
          json({ error: { code: 'UNAVAILABLE' } }, 503);
          return;
        }
        const projectMode = projectId ? (modes.get(projectId) ?? 'follow') : 'follow';
        const view: RtkSettingsView = {
          globalEnabled,
          projectMode,
          effectiveEnabled: projectMode === 'follow' ? globalEnabled : projectMode === 'on',
          source: projectMode === 'follow' ? 'global' : 'project',
          available,
          ...(!available ? { unavailableReason: 'resource-unavailable' } : {}),
        };
        json(view);
      } else if (url.pathname === '/api/bootstrap') {
        json({ csrfToken: 'fixture-only', config: {} });
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
      const origin = `http://127.0.0.1:${address.port}`;
      await page.goto(origin);
      const skills = page.getByRole('tab', { name: /Skills/ });
      await skills.focus();
      await page.keyboard.press('End');
      const hooks = page.getByRole('tab', { name: 'Hooks', exact: true });
      assert.equal(await hooks.getAttribute('aria-selected'), 'true');
      assert.equal(await hooks.evaluate((element) => element === document.activeElement), true);
      const project = page.getByRole('combobox', { name: 'RTK for this project', exact: true });
      await project.getByText('Follow global', { exact: true }).waitFor();
      await page.getByText('Setting source: global default (enabled)', { exact: true }).waitFor();
      await project.click();
      await page.getByRole('option', { name: 'Disable', exact: true }).click();
      await page
        .getByRole('alert')
        .getByText(/Could not save RTK settings/)
        .waitFor();
      await project.getByText('Follow global', { exact: true }).waitFor();
      await project.click();
      await page.getByRole('option', { name: 'Disable', exact: true }).click();
      await page.getByText('Setting source: project override', { exact: true }).waitFor();
      await page.getByText('Disabled', { exact: true }).waitFor();
      const global = page.getByRole('switch', { name: 'Enable RTK by default globally' });
      assert.equal(await global.isChecked(), true);
      await global.press('Space');
      await page.waitForFunction(
        () => document.querySelector('input[role=switch]:checked') === null,
      );
      await project.click();
      await page.getByRole('option', { name: 'Enable', exact: true }).click();
      await project.getByText('Enable', { exact: true }).waitFor();
      await page.getByText('Enabled', { exact: true }).waitFor();
      await project.click();
      await page.getByRole('option', { name: 'Follow global', exact: true }).click();
      await page.getByText('Setting source: global default (disabled)', { exact: true }).waitFor();
      await page.getByRole('combobox', { name: 'Select the project for extensions' }).click();
      await page.getByRole('option', { name: 'beta', exact: true }).click();
      await hooks.click();
      await project.getByText('Follow global', { exact: true }).waitFor();
      assert.equal(await global.isChecked(), false);
      assert.equal(modes.get('alpha'), 'follow');
      assert.equal(modes.has('beta'), false);
      available = false;
      await page.reload();
      await hooks.click();
      await page.getByText('Currently unavailable', { exact: true }).waitFor();
      assert.equal(
        await global.isDisabled(),
        false,
        'preferences remain editable when resource is unavailable',
      );
      await page.getByRole('button', { name: '中文', exact: true }).click();
      await page.getByText('RTK · Bash 输出压缩', { exact: true }).waitFor();
      await page.getByText('当前不可用', { exact: true }).waitFor();
      await page
        .getByRole('combobox', { name: '本项目的 RTK', exact: true })
        .getByText('跟随全局', { exact: true })
        .waitFor();
      assert.equal(await page.getByRole('switch', { name: '全局默认启用 RTK' }).isChecked(), false);
      failSave = true;
      const zhProject = page.getByRole('combobox', { name: '本项目的 RTK', exact: true });
      await zhProject.click();
      await page.getByRole('option', { name: '停用', exact: true }).click();
      await page
        .getByRole('alert')
        .getByText('RTK 设置保存失败，仍保留先前的设置。请重试。', { exact: true })
        .waitFor();
      await zhProject.getByText('跟随全局', { exact: true }).waitFor();
      failRead = true;
      await page.reload();
      await hooks.click();
      await page
        .getByText('Could not load Hooks settings. Reload to try again.', { exact: true })
        .waitFor();
      failRead = false;
      await page.getByRole('button', { name: 'Reload', exact: true }).click();
      await project.waitFor();
      assert.ok(writes.some(({ projectId, type }) => projectId === null && type === 'global'));
      assert.ok(
        writes
          .filter(({ type }) => type === 'project')
          .every(({ projectId }) => projectId === 'alpha'),
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
