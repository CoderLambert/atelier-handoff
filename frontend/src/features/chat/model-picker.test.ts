/**
 * @file 验证模型菜单的降级提示、刷新和来源切换。
 * @implementation 在隔离浏览器和回环目录替身中检查手动 ID、路由深度、显式刷新及迟到响应隔离，不调用模型。
 * @updated 2026-11-22T01:30:00+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { GatewayModelCatalog } from '@shared/types';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

const config = (gateway: string) => ({
  config: { gateway, model: 'workspace-default', maxTurns: 1, timeoutMs: 1000 },
  capabilities: { commands: true },
  connection: { available: true, message: 'fixture' },
});
const sourceA: GatewayModelCatalog = {
  defaultModel: 'workspace-default',
  routesAvailable: true,
  models: [
    { id: 'workspace-default' },
    {
      id: 'shared',
      displayName: 'Shared A',
      provider: 'chatgpt-plan',
      effort: 'high',
      supportedEfforts: ['low', 'high'],
      serviceTier: 'priority',
    },
    { id: 'only-a', displayName: 'Only A' },
  ],
  discovery: {
    routes: { status: 'ready', modelCount: 2 },
    codex: { status: 'unavailable', reason: 'timeout', modelCount: 0 },
  },
};
const sourceB: GatewayModelCatalog = {
  defaultModel: 'workspace-default',
  routesAvailable: true,
  models: [{ id: 'only-b', displayName: 'Only B' }],
  discovery: {
    routes: { status: 'ready', modelCount: 1 },
    codex: { status: 'ready', modelCount: 1 },
  },
};

test(
  'model picker exposes degraded discovery, preserves manual IDs and isolates refreshed sources',
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
        import {ModelPicker} from '@/features/chat/model-picker';
        import {settingsKeys} from '@/use-query/settings/keys';
        const client = new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
        window.fixture = {switchSource() {client.setQueryData(settingsKeys.config, ${JSON.stringify(config('http://127.0.0.1:3002'))});}};
        function App() {
          const [model,setModel] = useState('saved-manual-id');
          const [effort,setEffort] = useState('low');
          return <><ModelPicker compact model={model} effort={effort} defaultModel="workspace-default" disabled={false} onModelChange={setModel} onEffortChange={setEffort}/><output id="selection">{model}:{effort}</output></>;
        }
        createRoot(document.getElementById('app')).render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
      `,
      },
      tsconfig: `${root}/tsconfig.json`,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    });
    const bundle = compiled.outputFiles[0]?.text;
    assert.ok(bundle);
    let source = sourceA;
    let hold = false;
    let heldResponse: ServerResponse | undefined;
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const path = req.url ?? '/';
      if (path === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return void res.end(bundle);
      }
      if (path === '/api/config') {
        res.setHeader('Content-Type', 'application/json');
        return void res.end(JSON.stringify(config('http://127.0.0.1:3001')));
      }
      if (path.startsWith('/api/models')) {
        requests.push(path);
        res.setHeader('Content-Type', 'application/json');
        if (hold) {
          heldResponse = res;
          return;
        }
        return void res.end(JSON.stringify(source));
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><main style="padding:100px"><div id="app"></div></main><script type="module" src="/bundle.js"></script></body></html>',
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
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      page.setDefaultTimeout(3000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      const settings = page.getByRole('button', { name: '模型与推理深度', exact: true });
      await settings.waitFor();
      await settings.click();
      const picker = page.getByRole('combobox', { name: '选择模型', exact: true });
      await picker.click();
      await page
        .getByText('补充模型列表暂不可用，仍可选择已显示的模型或手动输入 ID。', { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole('option', { name: 'saved-manual-id', exact: true }).count(),
        1,
      );
      assert.equal(await page.locator('#selection').textContent(), 'saved-manual-id:low');
      await page.getByRole('option', { name: 'Shared A', exact: true }).click();
      assert.equal(
        await page.getByRole('combobox', { name: '选择推理深度', exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole('combobox', { name: '选择推理深度', exact: true }).textContent(),
        '高',
      );
      assert.equal(await page.locator('#selection').textContent(), 'shared:low');
      await picker.click();
      await page.getByRole('option', { name: '手动输入 ID…', exact: true }).click();
      const input = page.getByRole('textbox', { name: '模型 ID', exact: true });
      await input.fill('custom-manual');
      await page.getByRole('button', { name: '使用此模型', exact: true }).click();
      assert.equal(await page.locator('#selection').textContent(), 'custom-manual:low');
      await settings.click();
      const effort = page.getByRole('combobox', { name: '选择推理深度', exact: true });
      await effort.click();
      await page.getByRole('option', { name: '中', exact: true }).click();
      assert.equal(await page.locator('#selection').textContent(), 'custom-manual:medium');
      await effort.click();
      await page.getByRole('option', { name: '低', exact: true }).click();
      await picker.click();
      await page.getByRole('option', { name: '刷新模型列表', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="选择模型"]')?.getAttribute('aria-expanded') ===
          'false',
      );
      assert.ok(requests.includes('/api/models?refresh=1'));
      await picker.click();
      await page.getByRole('option', { name: 'Only A', exact: true }).waitFor();
      hold = true;
      const refreshBefore = requests.filter((request) => request.includes('refresh=1')).length;
      await page.getByRole('option', { name: '刷新模型列表', exact: true }).click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="选择模型"]')?.getAttribute('aria-expanded') ===
          'false',
      );
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          clearInterval(interval);
          reject(new Error('refresh fixture not reached'));
        }, 2000);
        const interval = setInterval(() => {
          if (requests.filter((request) => request.includes('refresh=1')).length > refreshBefore) {
            clearInterval(interval);
            clearTimeout(deadline);
            resolve();
          }
        }, 10);
      });
      source = sourceB;
      hold = false;
      await page.evaluate('window.fixture.switchSource()');
      await picker.click();
      await page.getByRole('option', { name: 'Only B', exact: true }).waitFor();
      heldResponse?.end(JSON.stringify(sourceA));
      assert.equal(await page.getByRole('option', { name: 'Only A', exact: true }).count(), 0);
      assert.equal(
        await page.getByRole('option', { name: 'custom-manual', exact: true }).count(),
        1,
      );
      assert.equal(await page.locator('#selection').textContent(), 'custom-manual:low');
      assert.deepEqual(errors, []);
    } finally {
      heldResponse?.end();
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
