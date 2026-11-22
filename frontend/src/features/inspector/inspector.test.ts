/**
 * @file 验证精简后的工作详情与继承对话空态。
 * @implementation 使用合成快照、隔离 Chromium 和回环接口验证当前及所选运行、停止目标、会话审批与事件、实际用量和欢迎页，不读取用户数据或调用模型。
 * @updated 2026-11-22T00:00:00+08:00
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compile } from '@tailwindcss/node';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Snapshot } from '@/api/types';
import type { Permission, Run } from '@shared/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiI18n } from '@/i18n';
import { DetailField, StatusBadge } from './shared';

test('status badges preserve bilingual state labels and unknown historic values with semantic variants', async () => {
  const originalLanguage = uiI18n.language;
  try {
    for (const [language, labels] of [
      ['zh-CN', ['排队中', '待审批', '已完成', '失败', '已停止']],
      ['en', ['Queued', 'Pending approval', 'Completed', 'Failed', 'Stopped']],
    ] as const) {
      await uiI18n.changeLanguage(language);
      for (const [index, [status, variant]] of (
        [
          ['queued', 'info'],
          ['pending', 'warning'],
          ['completed', 'success'],
          ['failed', 'destructive'],
          ['stopped', 'secondary'],
        ] as const
      ).entries()) {
        const markup = renderToStaticMarkup(createElement(StatusBadge, { status }));
        assert.ok(markup.includes(`data-variant="${variant}"`));
        assert.ok(markup.includes(labels[index] ?? 'missing label'));
        assert.match(markup, /aria-hidden="true"/u);
      }
      const historic = renderToStaticMarkup(
        createElement(StatusBadge, { status: 'historic-<state>' }),
      );
      assert.match(historic, /data-variant="secondary"/u);
      assert.match(historic, /historic-&lt;state&gt;/u);
    }
  } finally {
    await uiI18n.changeLanguage(originalLanguage);
  }
});

test('detail fields keep zero and long content while marking missing values explicitly', () => {
  const field = (children: string | number | null) =>
    renderToStaticMarkup(createElement(DetailField, { label: 'Value', children }));
  assert.match(field(0), />0<\/dd>/u);
  assert.match(field(''), />—<\/dd>/u);
  assert.match(field(null), />—<\/dd>/u);
  const long = `first line\n${'long-path/'.repeat(100)}`;
  assert.ok(field(long).includes(long));
});

const at = '2026-11-21T10:00:00.000Z';
function run(id: string, status: Run['status']): Run {
  return {
    id,
    sessionId: 'session',
    projectId: 'project',
    prompt: `任务 ${id}`,
    status,
    mode: 'readonly',
    createdAt: at,
    startedAt: at,
    endedAt: status === 'running' ? null : at,
    reason: null,
    error: status === 'failed' ? '合成失败原因' : null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config: { gateway: 'http://fixture.test', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
  };
}
function snapshot(): Snapshot {
  return {
    session: {
      id: 'session',
      projectId: 'project',
      title: '合成会话',
      status: 'active',
      sdkSessionId: null,
      createdAt: at,
      updatedAt: at,
      draft: { text: '', mode: 'readonly', contextPaths: [], attachmentIds: [] },
    },
    project: {
      id: 'project',
      name: '重复项目名称',
      path: '/fixture/private-project',
      branch: 'fixture-branch',
      available: true,
      createdAt: at,
    },
    runs: [],
    messages: [],
    tools: [],
    permissions: [],
    artifacts: [],
    attachments: [],
    events: [],
    cursor: 0,
  };
}
function permission(id: string, runId: string, status: Permission['status']): Permission {
  return {
    id,
    runId,
    sessionId: 'session',
    toolCallId: `tool-${id}`,
    kind: 'write',
    path: `/fixture/${id}.txt`,
    command: null,
    before: null,
    after: `内容 ${id}`,
    diff: '',
    baseFingerprint: null,
    version: `version-${id}`,
    status,
    createdAt: at,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    reason: `合成审批 ${id}`,
  };
}
const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));

test(
  'Session changes keeps all approvals and diffs reachable without duplicating run details and inherited welcome',
  { skip: !browserPath, timeout: 45000 },
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
          import { SessionChanges } from '@/features/inspector';
          import { Conversation } from '@/features/chat/conversation';
          const root = createRoot(document.getElementById('app'));
          const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
          window.renderFixture = (snapshot, runId, view = 'changes') => root.render(
            <QueryClientProvider client={client}>
              {view === 'chat'
                ? <Conversation key={'chat-' + snapshot.session.id} snapshot={snapshot} onRetry={() => {}} onTrace={() => {}} submitting={false} />
                : <SessionChanges snapshot={snapshot} />}
            </QueryClientProvider>
          );
        `,
      },
      tsconfig: `${root}/tsconfig.json`,
      alias: {
        '@atelier/markdown': `${root}/../packages/markdown/src/index.tsx`,
        '@atelier/markdown/style.css': `${root}/../packages/markdown/src/style.css`,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      loader: { '.css': 'empty' },
    });
    const bundle = compiled.outputFiles[0]?.text;
    assert.ok(bundle);
    const utilities = await compile(readFileSync(`${root}/src/styles.css`, 'utf8'), {
      base: `${root}/src`,
      onDependency() {},
    });
    const candidates = [
      'features/inspector/index.tsx',
      'features/inspector/shared.tsx',
      'components/ui/badge.tsx',
      'components/ui/button.tsx',
      'components/ui/dialog.tsx',
    ].flatMap((path) => readFileSync(`${root}/src/${path}`, 'utf8').split(/[\s"'`{}<>]/));
    const styles = utilities.build(candidates);
    const requests: string[] = [];
    let current = snapshot();
    const server = createServer((req, res) => {
      const path = req.url ?? '/';
      if (path === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return void res.end(bundle);
      }
      if (path.startsWith('/api/')) {
        requests.push(`${req.method} ${path}`);
        res.setHeader('Content-Type', 'application/json');
        if (path === '/api/bootstrap')
          return void res.end(JSON.stringify({ csrfToken: 'fixture' }));
        const item = current.permissions.find(
          (item) =>
            path === `/api/permissions/${item.id}` || path === `/api/permissions/${item.id}/diff`,
        );
        if (item)
          return void res.end(JSON.stringify(path.endsWith('/diff') ? item : { permission: item }));
        res.statusCode = 404;
        return void res.end(JSON.stringify({ error: { message: `Unexpected fixture ${path}` } }));
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${styles}</style></head><body><main style="width:320px;height:calc(100dvh - 32px);margin:16px"><div id="app" style="height:100%"></div></main><script type="module" src="/bundle.js"></script></body></html>`,
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
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      async function render(value: Snapshot | undefined, runId?: string, view = 'inspector') {
        current = value ?? snapshot();
        await page.evaluate(
          `window.renderFixture(${JSON.stringify(value)}, ${JSON.stringify(runId)}, ${JSON.stringify(view)})`,
        );
      }
      await render(undefined);
      await page.getByText('正在加载会话变更…', { exact: true }).waitFor();
      await render(snapshot());
      const empty = page.getByRole('status');
      await empty.getByText('暂无操作记录。', { exact: true }).waitFor();
      assert.equal(await page.locator('article').count(), 0);
      assert.equal(
        await empty.evaluate((element) => element.getBoundingClientRect().height < 100),
        true,
      );
      assert.doesNotMatch(
        await page.locator('#app').innerText(),
        /本轮用量|用量暂无|会话管理|重复项目名称|private-project/,
      );

      const old = run('old', 'failed');
      old.plan = [{ content: '历史计划', status: 'completed' }];
      old.usage = {
        model: 'reported-old-model',
        inputTokens: 1234,
        outputTokens: 0,
        cacheReadTokens: null,
        cacheCreationTokens: 0,
        sdkEstimateUsd: 0,
        costEstimateUsd: null,
        pricingBasis: 'unknown',
        complete: false,
      };
      const active = run('current', 'running');
      active.prompt = '长任务'.repeat(150);
      const value = { ...snapshot(), runs: [old, active] };
      value.permissions = [
        permission('older-change', 'old', 'allowed'),
        permission('pending-change', 'current', 'pending'),
      ];
      value.events = [
        {
          id: 1,
          seq: 1,
          sessionId: 'session',
          runId: 'old',
          type: 'tool.finished',
          at,
          payload: { historical: true },
        },
        {
          id: 2,
          seq: 2,
          sessionId: 'session',
          runId: 'current',
          type: 'message.delta',
          at,
          payload: { text: '流式文本' },
        },
      ];
      await render(value, 'old');
      await page.getByText('/fixture/older-change.txt', { exact: true }).waitFor();
      await page.getByText('/fixture/pending-change.txt', { exact: true }).waitFor();
      assert.match(await page.locator('article').first().innerText(), /pending-change/);
      assert.doesNotMatch(
        await page.locator('#app').innerText(),
        /停止运行|任务计划|历史计划|本轮用量|所选运行用量|reported-old-model|工具结束|流式文本/,
      );
      assert.equal(await page.getByRole('tab').count(), 0);

      const approval = page.getByRole('button', { name: '查看详情与审批', exact: true });
      await approval.click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('合成审批 pending-change', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '查看文件差异', exact: true }).click();
      await dialog.getByText('合成审批 older-change', { exact: true }).waitFor();
      assert.ok(requests.includes('GET /api/permissions/older-change/diff'));
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });

      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        await page.setViewportSize(viewport);
        assert.equal(
          await page
            .getByRole('region', { name: '会话变更记录', exact: true })
            .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
        );
        assert.equal(
          await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),
          true,
        );
      }
      await approval.click();
      await dialog.getByText('合成审批 pending-change', { exact: true }).waitFor();
      const other = snapshot();
      other.session.id = 'other-session';
      await render(other);
      await dialog.waitFor({ state: 'hidden' });
      await page.getByText('暂无操作记录。', { exact: true }).waitFor();
      assert.equal(await page.locator('article').count(), 0);
      assert.ok(!requests.some((path) => /\/(stop|retry)$/.test(path)));

      await render(snapshot(), undefined, 'chat');
      await page.getByRole('heading', { name: '这次想做什么？', exact: true }).waitFor();
      const inherited = {
        ...snapshot(),
        inheritedMessages: [
          { id: 'inherited', role: 'user' as const, text: '继承的历史任务', createdAt: at },
        ],
      };
      await render(inherited, undefined, 'chat');
      await page.getByRole('region', { name: '分支继承的对话', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('heading', { name: '这次想做什么？', exact: true }).count(),
        0,
      );
      await render({ ...snapshot(), inheritedMessages: [] }, undefined, 'chat');
      await page.getByRole('heading', { name: '这次想做什么？', exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
