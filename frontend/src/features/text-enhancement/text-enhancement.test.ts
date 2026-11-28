/**
 * @file 验证共享增强控件在独立受控表单中的交互。
 * @implementation 用浏览器表单、可控制的模型回执和真实 React Query 验证竞态和撤销。
 * @updated 2026-11-28T18:00:00+08:00
 */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const executablePath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

test(
  'a standalone form can enhance, undo, cancel and reject stale responses',
  { skip: !executablePath, timeout: 30_000 },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
        import React, { useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { TextEnhanceAction } from '@/features/text-enhancement/text-enhance-action';
        import { useTextEnhancement } from '@/features/text-enhancement/use-text-enhancement';

        function Form() {
          const [target, setTarget] = useState('first-form');
          const [text, setText] = useState('first draft');
          const current = useRef(text);
          const [submitted, setSubmitted] = useState('');
          function write(next) {
            current.current = next;
            setText(next);
          }
          const action = useTextEnhancement({
            target, kind: 'instruction', text,
            onReplace(expected, replacement) {
              if (current.current !== expected) return false;
              write(replacement);
              return true;
            },
          });
          return <form onSubmit={event => {
            event.preventDefault();
            action.cancel();
            setSubmitted(current.current);
          }}>
            <textarea aria-label="Draft" value={text} onChange={event => write(event.target.value)} />
            <TextEnhanceAction action={action} />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setTarget('second-form')}>Switch</button>
            <output aria-label="Saved">{submitted}</output>
          </form>;
        }
        createRoot(document.getElementById('app')).render(
          <QueryClientProvider client={new QueryClient()}><Form /></QueryClientProvider>
        );
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
    const server = createServer((req, res) => {
      if (req.url === '/bundle.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(bundle);
      } else {
        res.setHeader('content-type', 'text/html');
        res.end(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><div id="app"></div><script type="module" src="/bundle.js"></script>',
        );
      }
    });
    const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      await page.route('**/api/bootstrap', (route) =>
        route.fulfill({ json: { csrfToken: 'fixture' } }),
      );
      // Ignore fetch cancellation deliberately so stale responses still reach the hook.
      await page.addInitScript(() => {
        const fetchFromBrowser = window.fetch;
        let delivered = 0;
        window.fetch = async (input, init) => {
          if (input !== '/api/text-enhancements') return fetchFromBrowser(input, init);
          const response = await fetchFromBrowser(input, { ...init, signal: undefined });
          const readJson = response.json.bind(response);
          response.json = async () => {
            const value: unknown = await readJson();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                document.body.dataset.delivered = String(++delivered);
              }),
            );
            return value;
          };
          return response;
        };
      });
      const requests = new EventEmitter();
      let requestCount = 0;
      await page.route('**/api/text-enhancements', async (route) => {
        requestCount++;
        const reply = await new Promise<string>((resolve) => requests.emit('request', resolve));
        await route.fulfill({ json: { text: reply } });
      });
      await page.goto(`http://127.0.0.1:${address.port}`);
      const draft = page.getByRole('textbox', { name: 'Draft' });
      const enhance = page.getByRole('button', { name: '增强提示词', exact: true });
      const cancel = page.getByRole('button', { name: '取消增强', exact: true });
      const undo = page.getByRole('button', { name: '撤销增强', exact: true });
      async function start() {
        const index = requestCount + 1;
        const requested = once(requests, 'request');
        await enhance.evaluate((el: HTMLElement) => {
          el.click();
          el.click();
        });
        const [reply] = await requested;
        assert.equal(typeof reply, 'function');
        await cancel.waitFor();
        return async (text: string) => {
          reply(text);
          await page.waitForFunction(
            (count) => document.body.dataset.delivered === count,
            String(index),
          );
        };
      }
      const first = await start();
      await first('enhanced draft');
      await undo.waitFor();
      assert.equal(requestCount, 1);
      assert.equal(await draft.inputValue(), 'enhanced draft');
      await undo.press('Enter');
      assert.equal(await draft.inputValue(), 'first draft');
      assert.equal(await enhance.evaluate((button) => button === document.activeElement), true);
      const cancelled = await start();
      await cancel.press('Space');
      await cancelled('late after cancel');
      assert.equal(await draft.inputValue(), 'first draft');
      assert.equal(await undo.count(), 0);
      const afterEdit = await start();
      await draft.fill('edited in flight');
      await afterEdit('late after edit');
      assert.equal(await draft.inputValue(), 'edited in flight');
      assert.equal(await undo.count(), 0);
      const afterSave = await start();
      await page.getByRole('button', { name: 'Save' }).click();
      await afterSave('late after save');
      assert.equal(await draft.inputValue(), 'edited in flight');
      assert.equal(await undo.count(), 0);
      assert.equal(await page.getByLabel('Saved').textContent(), 'edited in flight');
      const afterSwitch = await start();
      await page.getByRole('button', { name: 'Switch' }).click();
      await afterSwitch('late after target switch');
      assert.equal(await draft.inputValue(), 'edited in flight');
      assert.equal(await undo.count(), 0);
      const final = await start();
      await final('enhanced again');
      await undo.waitFor();
      await draft.fill('manual edit');
      await undo.waitFor({ state: 'hidden' });
      await draft.fill('enhanced again');
      assert.equal(await undo.count(), 0);
      assert.equal(await draft.inputValue(), 'enhanced again');
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
