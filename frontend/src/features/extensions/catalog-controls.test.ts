/**
 * @file 验证共享目录控件与受控开关的交互契约。
 * @implementation 在隔离的 Chromium 沙箱中核对受控开关、目录选择与筛选回调，以及下拉键盘操作、禁用选项和必填校验。
 * @updated 2026-11-26T19:15:50+08:00
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));

test(
  'catalog controls preserve controlled values, keyboard switching, labels and native form disabling',
  { skip: !browserPath, timeout: 30_000 },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { CatalogProjectSelect, CatalogToolbar } from '@/components/catalog-toolbar';
          import { Switch } from '@/components/ui/switch';
          import { OptionsSelect } from '@/components/options-select';
          function App() {
            const [checked, setChecked] = useState(false);
            const [locked, setLocked] = useState(false);
            const [accept, setAccept] = useState(false);
            const [calls, setCalls] = useState(0);
            const [project, setProject] = useState('a');
            const [search, setSearch] = useState('');
            const [filter, setFilter] = useState('');
            const [target, setTarget] = useState('');
            return <>
              <form className="ext-dialog" onSubmit={(event) => event.preventDefault()}>
                <fieldset disabled={locked}>
                  <label htmlFor="feature">Enable feature</label>
                  <p id="feature-help">Changes stay controlled by the parent.</p>
                  <Switch id="feature" checked={checked} aria-describedby="feature-help"
                    onCheckedChange={(value) => { setCalls((old) => old + 1); if (accept) setChecked(value); }} />
                </fieldset>
                <output aria-label="Change calls">{calls}</output>
                <button type="button" onClick={() => setAccept(true)}>Accept changes</button>
                <button type="button" onClick={() => setLocked(!locked)}>Toggle lock</button>
              </form>
              <CatalogProjectSelect label="Current project" selectLabel="Choose project"
                value={project} options={[{value:'a',label:'Alpha'},{value:'b',label:'Beta'}]}
                emptyLabel="No projects" onValueChange={setProject} />
              <CatalogToolbar search={{ label:'Search catalog', placeholder:'Find entries', value:search, onChange:setSearch }}
                filter={{ label:'Status', value:filter, options:[{value:'',label:'All'},{value:'enabled',label:'Enabled'}], onChange:setFilter }}>
                <button type="button" onClick={() => { setSearch(''); setFilter(''); }}>Reset filters</button>
              </CatalogToolbar>
              <form id="required-select">
                <OptionsSelect aria-label="Select target service" required value={target} onValueChange={setTarget}
                  options={[{value:'',label:'Choose service'},{value:'retired',label:'Unavailable service',disabled:true},{value:':ready',label:'Available service'}]}/>
              </form>
              <output aria-label="Catalog values">{JSON.stringify({project,search,filter})}</output>
            </>;
          }
          createRoot(document.getElementById('app')).render(<App />);
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
    const utilities = await compile(
      [
        readFileSync(`${root}/src/styles.css`, 'utf8'),
        readFileSync(`${root}/src/features/extensions/extensions.css`, 'utf8'),
      ].join('\n'),
      { base: `${root}/src`, onDependency() {} },
    );
    const candidates = [
      'components/catalog-toolbar.tsx',
      'components/options-select.tsx',
      'components/ui/select.tsx',
      'components/ui/switch.tsx',
    ].flatMap((path) =>
      Array.from(
        readFileSync(`${root}/src/${path}`, 'utf8').matchAll(/['"]([^'"\n]+)['"]/g),
        (match) => match[1] ?? '',
      ).flatMap((value) => value.split(/\s+/)),
    );
    const styles = utilities.build(candidates);
    const server = createServer((request, response) => {
      if (request.url === '/bundle.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(bundle);
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style></head><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>`,
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
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      const toggle = page.getByRole('switch', { name: 'Enable feature', exact: true });
      await toggle.waitFor();
      assert.deepEqual(
        await toggle.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
        { width: 40, height: 24 },
      );
      assert.equal(await toggle.getAttribute('aria-describedby'), 'feature-help');
      await toggle.press('Space');
      assert.equal(await page.getByLabel('Change calls').textContent(), '1');
      assert.equal(await toggle.isChecked(), false);
      await page.getByRole('button', { name: 'Accept changes' }).click();
      await page.getByText('Enable feature', { exact: true }).click();
      assert.equal(await toggle.isChecked(), true);
      await toggle.press('Space');
      assert.equal(await toggle.isChecked(), false);
      await toggle.click({ position: { x: 38, y: 12 } });
      assert.equal(await toggle.isChecked(), true);
      await page.getByRole('button', { name: 'Toggle lock' }).click();
      assert.equal(await toggle.isDisabled(), true);
      assert.equal(
        await page
          .locator('[data-slot="switch-track"]')
          .evaluate((element) => getComputedStyle(element).opacity),
        '0.5',
      );
      assert.equal(await page.getByLabel('Change calls').textContent(), '4');
      await page.getByRole('button', { name: 'Toggle lock' }).click();
      assert.equal(await toggle.isDisabled(), false);

      const project = page.getByRole('combobox', { name: 'Choose project' });
      assert.equal(await project.evaluate((element) => element.tagName), 'BUTTON');
      await project.press('ArrowDown');
      await page.getByRole('listbox').waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await project.evaluate((element) => document.activeElement === element), true);
      await project.click();
      await page.getByRole('option', { name: 'Beta', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Search catalog' }).fill('needle');
      const filter = page.getByRole('combobox', { name: 'Status' });
      await filter.click();
      await page.getByRole('option', { name: 'Enabled', exact: true }).click();
      assert.deepEqual(
        JSON.parse((await page.getByLabel('Catalog values').textContent()) ?? '{}'),
        {
          project: 'b',
          search: 'needle',
          filter: 'enabled',
        },
      );
      await page.getByRole('button', { name: 'Reset filters' }).click();
      assert.equal(await page.getByRole('searchbox', { name: 'Search catalog' }).inputValue(), '');
      assert.equal((await filter.textContent())?.trim(), 'All');
      assert.equal((await project.textContent())?.trim(), 'Beta');
      const form = page.locator('#required-select');
      const target = page.getByRole('combobox', { name: 'Select target service' });
      const isValid = () =>
        form.evaluate((element) => element instanceof HTMLFormElement && element.checkValidity());
      assert.equal(await isValid(), false);
      await target.click();
      assert.equal(
        await page.getByRole('option', { name: 'Unavailable service', exact: true }).isDisabled(),
        true,
      );
      await page.getByRole('option', { name: 'Available service', exact: true }).click();
      assert.equal(await isValid(), true);
      await target.click();
      await page.getByRole('option', { name: 'Choose service', exact: true }).click();
      assert.equal(await isValid(), false);
      for (const [width, height] of [
        [1280, 800],
        [1440, 900],
        [1920, 1080],
        [600, 800],
      ] as const) {
        await page.setViewportSize({ width, height });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(
          await page.getByRole('searchbox', { name: 'Search catalog' }).isVisible(),
          true,
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
