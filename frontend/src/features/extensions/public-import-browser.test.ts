/**
 * @file 验证 GitHub 仓库查询到安装的界面流程。
 * @implementation 用 Chromium 和可控响应核对推荐版本、手动切换、安装按钮及固定提交请求。
 * @updated 2026-11-26T16:00:00+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { PublicEntry, PublicImportInput } from '@shared/public-extensions';

const browserPath = [process.env.ATELIER_TEST_CHROMIUM, '/usr/bin/chromium'].find(
  (path) => path && existsSync(path),
);

test(
  'GitHub repository results open the recommended preview and keep installation explicit',
  {
    skip: !browserPath,
    timeout: 30_000,
  },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const bundle = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
        import { uiI18n } from '@/i18n';
        import { PublicImport } from '@/features/extensions/public-import';
        uiI18n.changeLanguage('en').then(() => createRoot(document.getElementById('app')).render(
          <QueryClientProvider client={new QueryClient()}>
            <PublicImport projectId="fixture" projectName="Fixture" kind="skill" onClose={() => {}} onSaved={() => {}} />
          </QueryClientProvider>
        ));
      `,
      },
      tsconfig: root + '/tsconfig.json',
      bundle: true,
      write: false,
      format: 'esm',
      loader: { '.css': 'empty' },
    });
    const source = 'https://github.com/sample/repo.git';
    const ambiguousSource = source + '?catalog=ambiguous';
    const commit = 'a'.repeat(40);
    const entries: PublicEntry[] = ['.claude', '.agents'].map((dir) => {
      const path = dir + '/skills/sample';
      const key = path + '/SKILL.md';
      return {
        kind: 'skill',
        name: 'sample',
        description: dir,
        key,
        location: 'https://raw.githubusercontent.com/sample/repo/HEAD/' + key,
        github: { ref: 'HEAD', commit, path },
        recommended: dir === '.claude',
      };
    });
    const imported: PublicImportInput[] = [];
    const server = createServer((req, res) => {
      if (req.url === '/bundle.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(bundle.outputFiles[0]?.contents);
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><div id="app"></div><script type="module" src="/bundle.js"></script>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      await page.route('**/api/**', async (route) => {
        const url = route.request().url();
        if (url.endsWith('/api/bootstrap'))
          return route.fulfill({ json: { csrfToken: 'fixture' } });
        if (url.endsWith('/github-connection')) return route.fulfill({ json: { login: null } });
        if (url.endsWith('/public-preview')) {
          const input = route.request().postDataJSON();
          if (input.source === source) return route.fulfill({ json: { items: entries } });
          if (input.source === ambiguousSource)
            return route.fulfill({
              json: { items: entries.map((entry) => ({ ...entry, recommended: false })) },
            });

          const match = entries.find(({ location }) => location === input.source);
          assert.ok(match);
          assert.deepEqual(input.github, match.github);
          return route.fulfill({
            json: {
              items: [
                {
                  ...match,
                  body: '# Fixture Skill',
                  revision: 'body-revision',
                  packageManifest: { digest: 'b'.repeat(64), files: ['SKILL.md'] },
                },
              ],
            },
          });
        }
        if (url.endsWith('/public-import')) {
          imported.push(route.request().postDataJSON());
          return route.fulfill({
            json: {
              item: {
                id: 'fixture-skill',
                name: 'sample',
                kind: 'skill',
                enabled: true,
                version: 1,
              },
            },
          });
        }
        return route.abort();
      });
      await page.goto('http://127.0.0.1:' + address.port);
      const link = page.getByLabel('GitHub repository, folder, or file link');
      await link.fill(source);
      await page.getByRole('button', { name: 'Look up', exact: true }).click();
      const install = page.getByRole('button', { name: 'Install Skill', exact: true });
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) => button.textContent?.trim() === 'Install Skill' && !button.disabled,
        ),
      );
      const claude = page.getByRole('button', { name: /\.claude\/skills\/sample/ });
      assert.equal(await claude.getAttribute('aria-pressed'), 'true');
      assert.equal(imported.length, 0);
      const agents = page.getByRole('button', { name: /\.agents\/skills\/sample/ });
      await agents.click();
      assert.equal(await agents.getAttribute('aria-pressed'), 'true');
      await install.click();
      await page.getByRole('dialog', { name: 'Imported into the current project' }).waitFor();
      assert.equal(imported.length, 1);
      assert.equal(imported[0]?.key, entries[1]?.key);
      assert.deepEqual(imported[0]?.github, entries[1]?.github);
      assert.equal(imported[0]?.packageDigest, 'b'.repeat(64));
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
