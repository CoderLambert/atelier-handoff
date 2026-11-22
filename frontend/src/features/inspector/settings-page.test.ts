/**
 * @file 验证独立设置页的模型选择、保存、布局和诊断交互。
 * @implementation 在隔离浏览器与回环配置替身中覆盖 Magpie 开关的独立保存、失败恢复和草稿保留，以及目录切换、布局校验和诊断导出。
 * @updated 2026-11-22T13:50:57+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { ConfigInfo } from '@/api/types';
import type { GatewayModelCatalog } from '@shared/types';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

const initial: ConfigInfo = {
  config: {
    gateway: 'http://127.0.0.1:3001',
    managedGateway: true,
    model: 'saved-unavailable-model',
    maxTurns: 25,
    timeoutMs: 60000,
  },
  managedGateway: {
    externalGateway: 'http://127.0.0.1:3002',
    configPath: '/fixture/gateway/config.json',
    accountPresent: false,
  },
  capabilities: { commands: true },
  connection: { available: true, message: '本机连接正常。' },
};
const catalog = (external: boolean): GatewayModelCatalog => ({
  defaultModel: 'saved-unavailable-model',
  routesAvailable: true,
  models: [{ id: external ? 'only-b' : 'only-a', displayName: external ? 'Only B' : 'Only A' }],
  discovery: {
    routes: { status: 'ready', modelCount: 1 },
    codex: { status: 'skipped', reason: 'not-applicable', modelCount: 0 },
  },
});

test(
  'settings page preserves drafts and manual models, isolates unsaved sources, and separates diagnostics',
  { skip: !browserPath, timeout: 30_000 },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
          import React, {useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
          import SettingsPage from '@/features/inspector/settings-page';
          import {initialWorkspaceLayout} from '@shared/workspace-layout';
          import {initializeUiLanguage} from '@/i18n';
          const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
          window.fixture = {exports: 0, exportResult: false, layout: undefined};
          window.atelierDesktopFiles = {async exportDiagnostics(){ window.fixture.exports++; return window.fixture.exportResult; }};
          function App() {
            const [section,setSection] = useState('models');
            const [layout,setLayout] = useState(initialWorkspaceLayout);
            return <SettingsPage section={section} onSectionChange={setSection} layout={{layout,pending:false,onApply(value){setLayout(value);window.fixture.layout=value;}}}/>;
          }
          await initializeUiLanguage();
          createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
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
    let current = initial;
    let failSave = true;
    let failCatalog = false;
    let saves = 0;
    let modelRequests = 0;
    let failMagpie = true;
    const magpiePatches: Partial<ConfigInfo['config']>[] = [];
    const server = createServer(async (req, res) => {
      const path = req.url ?? '/';
      if (path === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(bundle);
        return;
      }
      if (path === '/api/bootstrap') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...current, csrfToken: 'fixture' }));
        return;
      }
      if (path === '/api/config' && req.method === 'PATCH') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const config = JSON.parse(Buffer.concat(chunks).toString()) as Partial<
          ConfigInfo['config']
        >;
        res.setHeader('Content-Type', 'application/json');
        if (config.magpieEnabled !== undefined) {
          magpiePatches.push(config);
          if (failMagpie) {
            failMagpie = false;
            res.statusCode = 503;
            res.end(JSON.stringify({ error: { message: 'Magpie 设置保存失败。' } }));
          } else {
            current = { ...current, config: { ...current.config, ...config } };
            res.end(JSON.stringify(current));
          }
          return;
        }
        saves++;
        if (failSave) {
          failSave = false;
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { message: 'fixture 保存失败，请重试。' } }));
        } else {
          current = { ...current, config: { ...current.config, ...config } };
          res.end(JSON.stringify(current));
        }
        return;
      }
      if (path === '/api/config') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(current));
        return;
      }
      if (path.startsWith('/api/models')) {
        modelRequests++;
        res.setHeader('Content-Type', 'application/json');
        if (failCatalog) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { message: 'fixture 目录不可用。' } }));
        } else res.end(JSON.stringify(catalog(current.config.managedGateway === false)));
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>',
      );
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
      page.setDefaultTimeout(3000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      const picker = page.getByRole('combobox', { name: '默认模型', exact: true });
      await picker.click();
      await page.getByRole('option', { name: 'Only A', exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('option', { name: 'saved-unavailable-model（当前设置）', exact: true })
          .count(),
        1,
      );
      await page.keyboard.press('Escape');
      assert.equal(current.config.model, 'saved-unavailable-model');

      await page.getByRole('button', { name: '手动输入模型名称', exact: true }).click();
      const manual = page.getByRole('textbox', { name: '模型名称', exact: true });
      await manual.fill('custom-manual');
      await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('textbox', { name: 'Model name', exact: true }).inputValue(),
        'custom-manual',
      );
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      assert.equal(saves, 0);
      await page.getByRole('combobox', { name: 'Display language', exact: true }).click();
      await page.getByRole('option', { name: '简体中文', exact: true }).click();
      await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
      assert.equal(await manual.inputValue(), 'custom-manual');
      const magpieSwitch = page.getByRole('switch', { name: '允许接入 Magpie' });
      assert.equal(await magpieSwitch.isChecked(), false);
      await magpieSwitch.click();
      await page.getByText('请求未完成，请稍后重试。', { exact: true }).waitFor();
      assert.equal(await magpieSwitch.isChecked(), false);
      await magpieSwitch.press('Space');
      await page.getByRole('switch', { name: '允许接入 Magpie', checked: true }).waitFor();
      await magpieSwitch.click();
      await page.getByRole('switch', { name: '允许接入 Magpie', checked: false }).waitFor();
      assert.deepEqual(magpiePatches, [
        { magpieEnabled: true },
        { magpieEnabled: true },
        { magpieEnabled: false },
      ]);
      assert.equal(await manual.inputValue(), 'custom-manual');
      assert.equal(current.config.model, 'saved-unavailable-model');
      await page.getByRole('button', { name: '工作区布局', exact: true }).click();
      const navigation = page.getByRole('spinbutton', { name: '导航栏宽度', exact: true });
      await navigation.fill('999');
      assert.equal(
        await page.getByRole('button', { name: '保存并应用', exact: true }).isDisabled(),
        true,
      );
      await navigation.fill('300');
      const browserWidth = page.getByRole('spinbutton', { name: '浏览器宽度', exact: true });
      await browserWidth.fill('420');
      await page.getByRole('button', { name: '模型与网关', exact: true }).click();
      assert.equal(await manual.inputValue(), 'custom-manual');
      await page.getByRole('combobox', { name: '网关来源', exact: true }).click();
      await page.getByRole('option', { name: '外部网关', exact: true }).click();
      await page.getByText('网关来源尚未保存。', { exact: false }).waitFor();
      await page.getByRole('button', { name: '从模型列表选择', exact: true }).click();
      assert.equal(await picker.isDisabled(), true);
      assert.equal(
        await page.getByRole('button', { name: '刷新模型列表', exact: true }).isDisabled(),
        true,
      );
      assert.equal(await page.getByRole('option', { name: 'Only A', exact: true }).count(), 0);
      const requestsBeforeSave = modelRequests;
      await page.getByRole('button', { name: '手动输入模型名称', exact: true }).click();
      await manual.fill('bad model');
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByText('模型名称须为 1–200 个字符，不能包含空白。', { exact: true }).waitFor();
      assert.equal(saves, 0);
      await manual.fill('custom-manual');
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByText('请求未完成，请稍后重试。', { exact: true }).waitFor();
      assert.equal(await manual.inputValue(), 'custom-manual');
      assert.equal(modelRequests, requestsBeforeSave);
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByText('设置已保存，网关可访问。', { exact: true }).waitFor();
      assert.equal(saves, 2);
      assert.equal(current.config.model, 'custom-manual');
      assert.equal(current.config.gateway, 'http://127.0.0.1:3002');
      await page.getByRole('button', { name: '从模型列表选择', exact: true }).click();
      await picker.click();
      await page.getByRole('option', { name: 'Only B', exact: true }).waitFor();
      assert.equal(await page.getByRole('option', { name: 'Only A', exact: true }).count(), 0);
      await page.getByRole('option', { name: 'Only B', exact: true }).click();
      failCatalog = true;
      await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
      await page.getByText('模型列表加载失败：', { exact: false }).waitFor();
      assert.equal(await picker.textContent(), 'Only B');

      await page.getByRole('button', { name: '工作区布局', exact: true }).click();
      assert.equal(await navigation.inputValue(), '300');
      assert.equal(await browserWidth.inputValue(), '420');
      await page.getByRole('button', { name: '保存并应用', exact: true }).click();
      assert.equal(await page.evaluate('window.fixture.layout.defaults.left'), 300);
      assert.equal(await page.evaluate('window.fixture.layout.recent.right'), 420);
      await page.getByRole('button', { name: '恢复默认布局', exact: true }).click();
      assert.equal(await navigation.inputValue(), '232');
      assert.equal(await browserWidth.inputValue(), '320');
      assert.equal(await page.evaluate('window.fixture.layout.defaults.left'), 232);
      assert.equal(await page.evaluate('window.fixture.layout.recent.right'), 320);
      await page.getByRole('button', { name: '诊断', exact: true }).click();
      assert.equal(
        await page.getByRole('button', { name: '保存设置', exact: true }).isVisible(),
        false,
      );
      await page.getByRole('button', { name: '导出诊断', exact: true }).click();
      await page.getByText('已取消导出。', { exact: true }).waitFor();
      await page.evaluate('window.fixture.exportResult = true');
      await page.getByRole('button', { name: '导出诊断', exact: true }).click();
      await page.getByText('诊断文件已保存。', { exact: true }).waitFor();
      assert.equal(await page.evaluate('window.fixture.exports'), 2);
      await page.getByRole('combobox', { name: '界面语言', exact: true }).click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await page.getByText('Diagnostic file saved.', { exact: true }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      assert.equal(
        await page.getByRole('combobox', { name: 'Display language', exact: true }).textContent(),
        'English',
      );
      assert.equal(saves, 2);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
