/**
 * @file 验证消息布局、操作、引用草稿、快捷插入及任务清单。
 * @implementation 使用隔离浏览器和回环 HTTP 替身覆盖消息布局、草稿操作、发送失败恢复，以及清单的键盘折叠、状态更新、历史查看和会话隔离。
 * @updated 2026-11-25T18:05:55+08:00
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compile } from '@tailwindcss/node';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { composerTextLimit, formatMessageText } from '@shared/message-quotes';
import { activeStatuses, type Draft, type Permission, type Run, type ToolCall } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { MessageActions } from './message-actions';
import { rewindUnavailableReason } from './message-actions-model';

const at = '2026-11-21T00:00:00.000Z';
const userText = '原始用户正文\n第二行';
const assistantText =
  '# 回复\n\n[链接](https://example.test)\n\n第一段内容。\n\n第二段内容。\n\n```ts\nconst answer = 42;\n```';
const initialDraft: Draft = {
  text: '待续草稿',
  mode: 'edit',
  contextPaths: ['current.txt'],
  attachmentIds: ['current-file'],
  extensionSelections: [],
  model: 'fixture-model',
  effort: 'high',
};
const run: Run = {
  id: 'run',
  sessionId: 'session-a',
  projectId: 'project',
  prompt: userText,
  status: 'failed',
  mode: 'readonly',
  createdAt: at,
  startedAt: at,
  endedAt: at,
  reason: null,
  error: 'fixture interrupted',
  retryOf: null,
  contextPaths: ['historical.txt'],
  attachmentIds: ['old-file'],
  plan: [],
  usage: null,
  config: { gateway: 'http://fixture.test', model: 'old-model', maxTurns: 1, timeoutMs: 1000 },
};
const snapshot: Snapshot = {
  session: {
    id: 'session-a',
    projectId: 'project',
    title: 'Fixture A',
    status: 'active',
    sdkSessionId: null,
    createdAt: at,
    updatedAt: at,
    draft: initialDraft,
  },
  project: {
    id: 'project',
    name: 'Fixture',
    path: '/fixture',
    branch: '',
    available: true,
    createdAt: at,
  },
  messageQueue: { items: [], paused: false },
  messages: [
    {
      id: 'user',
      forkAnchor: { sdkSessionId: 'sdk', messageId: 'native-user' },
      sessionId: 'session-a',
      runId: 'run',
      role: 'user',
      text: userText,
      createdAt: at,
    },
    {
      id: 'assistant',
      forkAnchor: { sdkSessionId: 'sdk', messageId: 'native-assistant' },
      sessionId: 'session-a',
      runId: 'run',
      role: 'assistant',
      text: assistantText,
      createdAt: at,
    },
    {
      id: 'empty',
      sessionId: 'session-a',
      runId: 'empty-run',
      role: 'assistant',
      text: '',
      createdAt: at,
    },
  ],
  runs: [run],
  tools: [],
  permissions: [],
  artifacts: [],
  events: [],
  cursor: 0,
  attachments: ['current-file', 'old-file'].map((id) => ({
    id,
    sessionId: 'session-a',
    name: `${id}.txt`,
    mime: 'text/plain',
    size: 10,
    status: 'ready' as const,
    createdAt: at,
  })),
};

test('submission combines quote cards after the editable text and normalizes quote line endings', () => {
  assert.equal(
    formatMessageText('草稿  \n', [
      { id: 'a', text: 'a\r\n\r\nb' },
      { id: 'c', text: 'c' },
    ]),
    '草稿  \n\n\n> a\n>\n> b\n\n> c',
  );
  assert.equal(formatMessageText('plain'), 'plain');
});

test('fork affordance requires both an anchored message and an integration callback', () => {
  const message = snapshot.messages[0];
  assert.ok(message);
  const anchor = { sdkSessionId: 'sdk', messageId: 'native', configKey: 'config' };
  const render = (anchored: boolean, handler: boolean) =>
    renderToStaticMarkup(
      createElement(MessageActions, {
        message: { ...message, forkAnchor: anchored ? anchor : undefined },
        disabled: false,
        onFork: handler ? () => {} : undefined,
      }),
    );
  assert.ok(!render(false, true).includes('从这里分支'));
  assert.ok(!render(true, false).includes('从这里分支'));
  assert.ok(render(true, true).includes('从这里分支'));
});

test('rewind is independent from fork and requires a valid anchor, callback and later messages', () => {
  const message = snapshot.messages[0];
  assert.ok(message);
  const render = (options: Partial<Parameters<typeof MessageActions>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(MessageActions, {
        message,
        disabled: false,
        onRewind: () => {},
        subsequentMessageCount: 2,
        ...options,
      }),
    );
  assert.ok(render().includes('回退对话到此处'));
  assert.ok(!render().includes('从这里分支'));
  assert.ok(render({ onFork: () => {} }).includes('从这里分支'));
  assert.ok(!render({ onRewind: undefined }).includes('回退对话到此处'));
  assert.ok(!render({ subsequentMessageCount: 0 }).includes('回退对话到此处'));
  assert.ok(!render({ message: { ...message, forkAnchor: undefined } }).includes('回退对话到此处'));
  assert.ok(
    !render({
      message: { ...message, forkAnchor: { sdkSessionId: ' ', messageId: 'native' } },
    }).includes('回退对话到此处'),
  );
  assert.ok(
    render({ rewindDisabledReason: '请先处理队列' }).includes('title="请先处理队列" disabled=""'),
  );
});

const permission: Permission = {
  id: 'permission',
  sessionId: 'session-a',
  runId: 'run',
  toolCallId: 'tool',
  kind: 'write',
  path: '/fixture/file.txt',
  command: null,
  before: null,
  after: 'fixture',
  diff: '',
  baseFingerprint: null,
  version: 'v1',
  status: 'pending',
  createdAt: at,
  expiresAt: at,
  reason: 'fixture',
};

test('rewind blocks every active run and unresolved queue, approval or submission state', () => {
  assert.equal(rewindUnavailableReason(snapshot, false), undefined);
  assert.match(rewindUnavailableReason(snapshot, true) ?? '', /提交/);
  assert.match(
    rewindUnavailableReason(
      { ...snapshot, session: { ...snapshot.session, status: 'archived' } },
      false,
    ) ?? '',
    /归档/,
  );
  assert.match(
    rewindUnavailableReason(
      { ...snapshot, project: { ...snapshot.project, available: false } },
      false,
    ) ?? '',
    /不可用/,
  );
  for (const status of activeStatuses) {
    assert.match(
      rewindUnavailableReason(
        { ...snapshot, runs: [{ ...run, id: 'older-active', status }, run] },
        false,
      ) ?? '',
      /任务/,
    );
  }
  assert.match(
    rewindUnavailableReason({ ...snapshot, permissions: [permission] }, false) ?? '',
    /审批/,
  );
  assert.match(
    rewindUnavailableReason({ ...snapshot, messageQueue: undefined }, false) ?? '',
    /尚未确认/,
  );
  for (const delivery of [undefined, 'waiting', 'sending', 'unknown'] as const) {
    const queue = {
      items: [{ id: 'queued', text: 'fixture', createdAt: at, error: null, delivery }],
      paused: true,
    };
    assert.match(
      rewindUnavailableReason({ ...snapshot, messageQueue: queue }, false) ?? '',
      delivery === 'unknown' ? /投递结果待确认/ : /待处理消息/,
    );
  }
});

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));

test(
  'renderer actions preserve draft scope, focus and idempotent send/queue behavior',
  { skip: !browserPath, timeout: 60000 },
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
      import { Provider } from 'react-redux';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import SessionChat from '@/app/session-chat';
      import { actions, store } from '@/app/store';
      import { readDraft, updateDraft } from '@/app/drafts';
      import { sessionKeys } from '@/use-query/sessions/keys';
      import { permissionKeys } from '@/use-query/permissions/keys';
      const initial = ${JSON.stringify(snapshot)};
      const initialDraft = ${JSON.stringify(initialDraft)};
      let current = initial;
      const root = createRoot(document.getElementById('app'));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } } });
      window.events = [];
      let rewindMode = 'reject';
      async function rewind(messageId, expectedHeadId) {
        const id = current.session.id;
        window.events.push(['rewind', id, messageId, expectedHeadId]);
        if (rewindMode === 'hold') await new Promise((resolve, reject) => {
          window.resolveRewind = resolve;
          window.rejectRewind = () => reject(new Error('回退接口暂时失败'));
        });
        else if (rewindMode === 'reject') throw new Error('回退接口暂时失败');
        if (current.session.id !== id) return;
        const index = current.messages.findIndex(message => message.id === messageId);
        current = { ...current, messages: current.messages.slice(0, index + 1) };
        render();
      }
      function render() {
        root.render(<Provider store={store}><QueryClientProvider client={client}>
          <SessionChat snapshot={current} defaultModel="default" onSent={async (id) => { window.events.push(['sent', id]); }}
            onError={(error) => window.events.push(['error', error])} onTrace={() => {}}
            onStop={() => {}} onRetry={(id) => window.events.push(['retry', id])}
            onForkMessage={(id) => window.events.push(['fork', id])} onRewindMessage={rewind} />
        </QueryClientProvider></Provider>);
      }
      window.fixture = {
        rewindMode: (mode) => { rewindMode = mode; },
        appendMessage: () => {
          current = { ...current, messages: [...current.messages, { ...initial.messages[1], id: 'later-message', sessionId: current.session.id }] };
          render();
        },
        holdMutation: (type) => {
          const mutationKey = type === 'queue' ? sessionKeys.messageQueue(current.session.id) : permissionKeys.decide;
          const mutation = client.getMutationCache().build(client, { mutationKey,
            mutationFn: () => new Promise(resolve => { window.resolveMutation = resolve; }) });
          void mutation.execute(undefined);
        },
        draft: (id = current.session.id) => readDraft(id, initialDraft),
        text: (text) => updateDraft(current.session.id, previous => ({ ...previous, text }), initialDraft),
        addAttachment: () => updateDraft(current.session.id, previous => ({ ...previous, attachmentIds: [...previous.attachmentIds, 'later-file'] }), initialDraft),
        switch: (id = 'session-a') => {
          current = { ...initial, session: { ...initial.session, id },
            messages: initial.messages.map(message => ({ ...message, sessionId: id })),
            runs: initial.runs.map(run => ({ ...run, sessionId: id })) };
          render();
        },
        setRuns: (runs, tools) => {
          current = { ...current, runs, tools };
          render();
        },
        patch: (options) => {
          current = { ...current, session: { ...current.session, ...(options.archived === undefined ? {} : { status: options.archived ? 'archived' : 'active' }) },
            ...(options.active === undefined ? {} : { runs: current.runs.map(run => ({ ...run, status: options.active ? 'running' : 'failed' })) }),
            ...(options.assistantText === undefined ? {} : { messages: current.messages.map(message => message.id === 'assistant' ? { ...message, text: options.assistantText } : message) }),
            ...(options.queue === undefined ? {} : { messageQueue: options.queue === 'missing' ? undefined : options.queue }),
            ...(options.permission === undefined ? {} : { permissions: options.permission ? [${JSON.stringify(permission)}] : [] }),
            ...(options.inherited ? { inheritedMessages: [{ id: 'inherited', role: 'assistant', text: '**继承正文**', createdAt: initial.session.createdAt }] } : {}) };
          if (options.submitting !== undefined) store.dispatch(actions.setSubmitting({ id: current.session.id, pending: options.submitting }));
          render();
        },
      };
      let clipboardMode = 'ok';
      window.copies = [];
      window.setClipboardMode = (mode) => {
        clipboardMode = mode;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
          writeText: async (text) => {
            window.copies.push(text);
            if (clipboardMode === 'reject') throw new Error('permission denied');
            if (clipboardMode === 'hold') await new Promise(resolve => { window.releaseCopy = resolve; });
          }
        } });
      };
      window.setClipboardMode('ok');
      render();
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
    const utilities = await compile(
      [
        readFileSync(`${root}/src/styles.css`, 'utf8'),
        readFileSync(`${root}/src/features/chat/chat.css`, 'utf8'),
      ].join('\n'),
      { base: `${root}/src`, onDependency() {} },
    );
    // The fixture uses the current shared Button contract, including semantic
    // theme variables and icon sizing, instead of reproducing its old CSS.
    const buttonClasses = Array.from(
      readFileSync(`${root}/src/components/ui/button.tsx`, 'utf8').matchAll(/'([^']+)'/g),
      (match) => match[1] ?? '',
    ).flatMap((value) => value.split(/\s+/));
    const styles = utilities.build([...buttonClasses, 'sr-only', 'truncate', 'shrink-0']);
    const sends: { path: string; body: Draft & { idempotencyKey: string } }[] = [];
    const inserts: { path: string; body: unknown }[] = [];
    let rejectInsert = false;
    const server = createServer(async (req, res) => {
      const path = req.url ?? '/';
      if (path === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return void res.end(bundle);
      }
      if (path.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        if (path === '/api/bootstrap')
          return void res.end(JSON.stringify({ csrfToken: 'fixture' }));
        if (path.endsWith('/extensions')) return void res.end(JSON.stringify({ items: [] }));
        if (path.endsWith('/draft')) return void res.end(JSON.stringify({ ok: true }));
        if (path.endsWith('/insert')) {
          let body = '';
          for await (const part of req) body += String(part);
          inserts.push({ path, body: JSON.parse(body) });
          if (rejectInsert) {
            res.statusCode = 409;
            return void res.end(
              JSON.stringify({ error: { code: 'QUEUE_CHANGED', message: '消息不能实时插入' } }),
            );
          }
          return void res.end(JSON.stringify({ ok: true }));
        }
        if (path.endsWith('/messages')) {
          let body = '';
          for await (const part of req) body += String(part);
          sends.push({ path, body: JSON.parse(body) });
          if (sends.length === 1) {
            res.statusCode = 503;
            return void res.end(
              JSON.stringify({ error: { code: 'FIXTURE', message: '发送暂时失败' } }),
            );
          }
          return void res.end(
            JSON.stringify({
              queuedMessage: {
                id: 'queued',
                text: userText,
                createdAt: at,
                error: null,
                extensions: [],
              },
            }),
          );
        }
        res.statusCode = 404;
        return void res.end(
          JSON.stringify({ error: { message: `Unexpected fixture request ${path}` } }),
        );
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${styles}</style></head><body><main style="display:flex;flex-direction:column;height:100dvh;max-width:1000px;margin:auto"><div id="app" style="display:contents"></div></main><script type="module" src="/bundle.js"></script></body></html>`,
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
      const user = page.locator('[data-message-id="user"]');
      const assistant = page.locator('[data-message-id="assistant"]');
      const input = page.locator('#prompt-input');
      const edit = user.getByRole('button', { name: '编辑后发送', exact: true });
      const quote = assistant.getByRole('button', { name: '引用回复', exact: true });
      const copy = assistant.getByRole('button', { name: '复制 Markdown', exact: true });
      const readDraft = () => page.evaluate('window.fixture.draft()') as Promise<Draft>;
      await input.waitFor();
      const bubble = await user.locator('.user-message-bubble').boundingBox();
      const row = await user.boundingBox();
      const footer = await user.locator('.message-footer').boundingBox();
      const timestamp = user.locator('time[datetime][title]');
      const time = await timestamp.boundingBox();
      assert.ok(bubble && row && footer);
      assert.ok(bubble.width < row.width * 0.7);
      assert.ok(Math.abs(bubble.x + bubble.width - (row.x + row.width)) < 1);
      assert.ok(footer.y >= bubble.y + bubble.height);
      assert.ok(time);
      assert.ok(Math.abs(time.x + time.width - (bubble.x + bubble.width)) < 1);
      assert.equal(
        await user.locator('.message-footer').getByText('只读', { exact: true }).count(),
        0,
      );
      assert.equal(await page.locator('.message .avatar').count(), 0);
      assert.equal(await input.inputValue(), initialDraft.text);
      assert.equal(await page.locator('[data-message-id="empty"] .message-actions').count(), 0);
      const send = page.getByRole('button', { name: '发送任务', exact: true });
      const iconWidth = (button: typeof edit) =>
        button.locator('svg').evaluate((svg) => svg.getBoundingClientRect().width);
      assert.deepEqual(await Promise.all([iconWidth(edit), iconWidth(send)]), [16, 16]);

      // Copy uses original user text and assistant Markdown, including fences and links.
      await user.getByRole('button', { name: '复制消息', exact: true }).focus();
      assert.equal((await timestamp.boundingBox())?.x, time.x);
      await page.keyboard.press('Enter');
      await user.getByRole('status').filter({ hasText: '已复制' }).waitFor();
      await copy.click();
      await assistant.getByRole('status').filter({ hasText: '已复制' }).waitFor();
      assert.deepEqual(await page.evaluate('window.copies'), [userText, assistantText]);
      await page.evaluate("window.setClipboardMode('reject')");
      await copy.click();
      await assistant.getByRole('alert').waitFor();
      const fallback = assistant.getByRole('textbox', { name: '待复制的 Markdown' });
      assert.equal(await fallback.inputValue(), assistantText);
      await fallback.focus();
      assert.deepEqual(
        await fallback.evaluate((element: HTMLTextAreaElement) => ({
          start: element.selectionStart,
          end: element.selectionEnd,
        })),
        { start: 0, end: assistantText.length },
      );
      await page.evaluate("window.setClipboardMode('missing')");
      await user.getByRole('button', { name: '复制消息', exact: true }).click();
      await user.getByRole('alert').waitFor();
      assert.equal(
        await user.getByRole('textbox', { name: '待复制的消息正文' }).inputValue(),
        userText,
      );

      // Cancellation and Esc return to the exact trigger, preserving all draft fields.
      await edit.click();
      const dialog = page.getByRole('dialog');
      const keep = dialog.getByRole('button', { name: '保留草稿', exact: true });
      await keep.waitFor();
      await page.waitForFunction(() => document.activeElement?.textContent === '保留草稿');
      await keep.click();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '编辑后发送',
      );
      assert.deepEqual(await readDraft(), initialDraft);
      await edit.click();
      await dialog.waitFor();
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '编辑后发送',
      );
      assert.deepEqual(await readDraft(), initialDraft);

      await edit.click();
      await dialog.getByRole('button', { name: '替换草稿正文', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      assert.equal(await input.inputValue(), userText);
      assert.equal(
        await input.getAttribute('aria-describedby'),
        'input-help chat-composer-error composer-edit-help',
      );
      assert.deepEqual(await readDraft(), { ...initialDraft, text: userText });
      assert.equal(sends.length, 0);
      assert.equal(await user.locator('.message-text').innerText(), userText);

      // An attachment update while the replacement dialog is open survives confirmation.
      await edit.click();
      await dialog.waitFor();
      await page.evaluate('window.fixture.addAttachment()');
      await dialog.getByRole('button', { name: '替换草稿正文', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      assert.deepEqual((await readDraft()).attachmentIds, ['current-file', 'later-file']);
      await quote.click();
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      const cards = page.getByRole('list', { name: '已引用的回复' });
      await cards.waitFor();
      assert.equal(await cards.locator('.composer-quote-excerpt').textContent(), assistantText);
      assert.equal(await input.inputValue(), userText);
      const quoteState = [{ id: 'assistant', text: assistantText }];
      assert.deepEqual((await readDraft()).messageQuotes, quoteState);
      assert.equal(
        await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart),
        userText.length,
      );
      await quote.click();
      assert.equal(await cards.getByRole('listitem').count(), 1);
      await cards.getByRole('button', { name: '移除引用 1' }).click();
      await cards.waitFor({ state: 'hidden' });
      assert.equal(await input.inputValue(), userText);
      assert.deepEqual((await readDraft()).contextPaths, initialDraft.contextPaths);

      const selectionQuote = page.getByRole('button', { name: '引用所选', exact: true });
      const firstParagraph = assistant.getByText('第一段内容。', { exact: true });
      const lastParagraph = assistant.getByText('第二段内容。', { exact: true });
      await firstParagraph.scrollIntoViewIfNeeded();
      await lastParagraph.scrollIntoViewIfNeeded();
      const first = await firstParagraph.boundingBox();
      const last = await lastParagraph.boundingBox();
      assert.ok(first && last);
      await page.mouse.move(first.x + 1, first.y + first.height / 2);
      await page.mouse.down();
      await page.mouse.move(last.x + 45, last.y + last.height / 2, { steps: 8 });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await selectionQuote.count(), 0);
      await page.mouse.up();
      await selectionQuote.waitFor();
      const selected = await page.evaluate(() => getSelection()?.toString());
      assert.match(selected ?? '', /第一段内容。\n+第二段/);
      await selectionQuote.click();
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      assert.equal(await input.inputValue(), userText);
      assert.equal(await cards.locator('.composer-quote-excerpt').textContent(), selected);
      const selectionState = (await readDraft()).messageQuotes;
      assert.equal(selectionState?.[0]?.sourceMessageId, 'assistant');

      const selectText = async (locator: typeof firstParagraph) => {
        await locator.scrollIntoViewIfNeeded();
        await locator.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const selection = getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await selectionQuote.waitFor();
      };
      await selectText(firstParagraph);
      await page.keyboard.press('Escape');
      await selectionQuote.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => getSelection()?.toString()), '第一段内容。');
      await selectText(lastParagraph);
      await page.keyboard.press('Alt+Shift+q');
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      assert.deepEqual(await cards.locator('.composer-quote-excerpt').allTextContents(), [
        selected,
        '第二段内容。',
      ]);
      await selectText(lastParagraph);
      await selectionQuote.click();
      assert.equal(await cards.getByRole('listitem').count(), 2);
      await selectText(firstParagraph);
      await page.evaluate("window.fixture.switch('session-b')");
      await page.locator('[data-session-id="session-b"]').waitFor();
      assert.equal(await selectionQuote.count(), 0);
      assert.equal(await cards.count(), 0);
      await page.evaluate("window.fixture.switch('session-a')");
      await page.locator('[data-session-id="session-a"]').waitFor();
      assert.deepEqual(await cards.locator('.composer-quote-excerpt').allTextContents(), [
        selected,
        '第二段内容。',
      ]);
      await cards.getByRole('button', { name: '移除引用 1' }).click();
      assert.equal(await cards.locator('.composer-quote-excerpt').textContent(), '第二段内容。');
      await cards.getByRole('button', { name: '移除引用 1' }).click();
      await cards.waitFor({ state: 'hidden' });

      await page.evaluate(() => {
        const user = document.querySelector('[data-message-id="user"] .message-text')?.firstChild;
        const reply = document.querySelector(
          '[data-message-id="assistant"] .chat-markdown h1',
        )?.firstChild;
        if (!user || !reply) throw new Error('Missing cross-message selection fixture.');
        const range = document.createRange();
        range.setStart(user, 0);
        range.setEnd(reply, 1);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await selectionQuote.count(), 0);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await page.evaluate(
        `window.fixture.text(${JSON.stringify('x'.repeat(composerTextLimit - 1))})`,
      );
      await selectText(lastParagraph);
      await selectionQuote.click();
      await page.getByRole('alert').filter({ hasText: '选中的文字会超过输入上限' }).waitFor();
      assert.equal(await cards.count(), 0);
      await quote.click();
      await page.getByRole('alert').filter({ hasText: '整条引用会超过输入上限' }).waitFor();
      assert.equal((await readDraft()).text.length, composerTextLimit - 1);

      // Switching with a dialog or clipboard promise in flight never changes the other draft/focus.
      await edit.click();
      await dialog.waitFor();
      await page.evaluate("window.fixture.switch('session-b')");
      await page.locator('[data-session-id="session-b"]').waitFor();
      assert.equal(await dialog.count(), 0);
      assert.equal(await input.inputValue(), initialDraft.text);
      await page.evaluate("window.setClipboardMode('hold')");
      await copy.click();
      await assistant.getByRole('status').filter({ hasText: '正在复制' }).waitFor();
      await page.evaluate("window.fixture.switch('session-a'); window.releaseCopy()");
      await page.locator('[data-session-id="session-a"]').waitFor();
      assert.equal(await assistant.getByText('已复制', { exact: true }).count(), 0);
      assert.equal((await readDraft()).text.length, composerTextLimit - 1);
      await page.evaluate("window.fixture.text(''); window.fixture.patch({ archived: true })");
      await page.waitForFunction(
        () => document.querySelector<HTMLTextAreaElement>('#prompt-input')?.disabled,
      );
      assert.equal(await edit.isDisabled(), true);
      assert.equal(await quote.isDisabled(), true);
      assert.equal(await copy.isEnabled(), true);
      await page.evaluate("window.setClipboardMode('ok')");
      await copy.click();
      await assistant.getByRole('status').filter({ hasText: '已复制' }).waitFor();
      await page.evaluate('window.fixture.patch({ archived: false, submitting: true })');
      assert.equal(await edit.isDisabled(), true);
      await page.evaluate(
        'window.fixture.patch({ submitting: false, active: true, inherited: true })',
      );
      await edit.click();
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      assert.equal(await input.inputValue(), userText);
      const inherited = page.getByRole('region', { name: '分支继承的对话', exact: true });
      assert.equal(await inherited.locator('strong').filter({ hasText: '继承正文' }).count(), 1);
      assert.equal(await inherited.getByRole('button').count(), 0);
      const queue = page.getByRole('button', { name: '加入队列', exact: true });
      await queue.waitFor();
      assert.equal(await queue.textContent(), '');
      assert.equal(
        await page.locator('#input-help').evaluate((el) => el.getBoundingClientRect().height),
        1,
      );

      // IME Enter keeps editing; a deliberate send uses the existing draft/submit pipeline.
      await quote.click();
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      await selectText(lastParagraph);
      await selectionQuote.click();
      const submittedQuotes = (await readDraft()).messageQuotes;
      assert.deepEqual(
        submittedQuotes?.map(({ text }) => text),
        [assistantText, '第二段内容。'],
      );
      await input.dispatchEvent('compositionstart');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Alt+Enter');
      assert.equal(sends.length, 0);
      assert.equal(inserts.length, 0);
      await input.dispatchEvent('compositionend');
      const submittedText = await input.inputValue();
      await queue.click();
      await page.waitForFunction("window.events.some(([type]) => type === 'error')");
      assert.equal(await input.inputValue(), submittedText);
      await queue.click();
      await page.waitForFunction("window.events.some(([type]) => type === 'sent')");
      assert.equal(sends.length, 2);
      assert.deepEqual(sends[0], sends[1]);
      assert.equal(sends[0]?.path, '/api/sessions/session-a/messages');
      assert.equal(sends[0]?.body.text, formatMessageText(submittedText, submittedQuotes));
      assert.equal(sends[0]?.body.messageQuotes, undefined);
      assert.equal(inserts.length, 0);
      await cards.waitFor({ state: 'hidden' });
      assert.equal(sends[0]?.body.model, initialDraft.model);
      assert.equal(sends[0]?.body.mode, initialDraft.mode);
      assert.deepEqual(sends[0]?.body.attachmentIds, ['current-file', 'later-file']);
      assert.deepEqual(sends[0]?.body.contextPaths, ['current.txt']);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.getByText('编辑后将作为新一轮发送', { exact: true }).count(), 0);
      assert.equal(await input.getAttribute('aria-keyshortcuts'), 'Alt+Enter');
      await input.fill('立即补充');
      await input.press('Alt+Enter');
      await page.waitForFunction("window.events.filter(([type]) => type === 'sent').length === 2");
      assert.equal(sends[2]?.body.text, '立即补充');
      assert.deepEqual(inserts, [
        {
          path: '/api/sessions/session-a/message-queue/queued/insert',
          body: { runId: 'run', mode: 'live' },
        },
      ]);
      rejectInsert = true;
      await input.fill('不兼容的补充');
      await input.press('Alt+Enter');
      await page.waitForFunction("window.events.filter(([type]) => type === 'sent').length === 3");
      assert.equal(sends[3]?.body.text, '不兼容的补充');
      assert.equal(inserts.length, 2);
      assert.ok(
        ((await page.evaluate('window.events')) as string[][]).some(
          (event) => event[0] === 'error' && event[1]?.includes('消息已提交'),
        ),
      );
      assert.equal(await input.inputValue(), '');
      await page.evaluate('window.fixture.patch({ active: false })');
      const progress = page.getByRole('button', { name: '检查任务进度', exact: true });
      await progress.click();
      assert.ok(
        ((await page.evaluate('window.events')) as unknown[][]).some(
          (event) => event[0] === 'retry' && event[1] === 'run',
        ),
      );
      assert.equal(
        await page.getByText('助手会读取现有结果，检查已完成的工作。', { exact: true }).count(),
        1,
      );
      // Rewind keeps a separate affordance and confirmation; cancellation preserves the draft.
      await page.evaluate(
        "window.fixture.switch('session-a'); window.fixture.text('回退时保留的草稿')",
      );
      const rewind = user.getByRole('button', { name: '回退对话到此处', exact: true });
      const fork = user.getByRole('button', { name: '从这里分支', exact: true });
      await rewind.waitFor();
      assert.equal(
        await page.getByRole('button', { name: '回退对话到此处', exact: true }).count(),
        2,
      );
      await fork.click();
      assert.ok(
        ((await page.evaluate('window.events')) as unknown[][]).some(
          (event) => event[0] === 'fork' && event[1] === 'user',
        ),
      );
      assert.equal(await dialog.count(), 0);
      const beforeRewind = await readDraft();
      await rewind.click();
      const cancelRewind = dialog.getByRole('button', { name: '取消', exact: true });
      const confirmRewind = dialog.getByRole('button', { name: '确认回退', exact: true });
      await page.waitForFunction(() => document.activeElement?.textContent === '取消');
      assert.equal(await dialog.locator('blockquote').textContent(), userText);
      assert.ok((await dialog.innerText()).includes('后续 2 条消息'));
      assert.ok((await dialog.innerText()).includes('/fixture'));
      assert.ok((await dialog.innerText()).includes('回退前'));
      assert.ok((await dialog.innerText()).includes('当前的文件、浏览器状态和运行环境'));
      await page.keyboard.press('Tab');
      await page.waitForFunction(() => document.activeElement?.textContent === '确认回退');
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '回退对话到此处',
      );
      await rewind.click();
      await cancelRewind.click();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === '回退对话到此处',
      );
      assert.deepEqual(await readDraft(), beforeRewind);

      const waitForRewindDisabled = (value: boolean) =>
        page.waitForFunction(
          (disabled) =>
            document.querySelector<HTMLButtonElement>(
              '[data-message-id="user"] [aria-label="回退对话到此处"]',
            )?.disabled === disabled,
          value,
        );
      const queued = {
        items: [{ id: 'pending', text: '尚未处理', createdAt: at, error: null }],
        paused: true,
      };
      for (const [patch, explanation] of [
        [{ queue: 'missing' }, '尚未确认'],
        [{ queue: queued }, '待处理消息'],
        [
          {
            queue: {
              ...queued,
              items: queued.items.map((item) => ({ ...item, delivery: 'unknown' })),
            },
          },
          '投递结果待确认',
        ],
        [{ queue: { items: [], paused: false }, active: true }, '任务'],
        [{ active: false, permission: true }, '审批'],
        [{ permission: false, submitting: true }, '提交'],
      ] as const) {
        await page.evaluate(`window.fixture.patch(${JSON.stringify(patch)})`);
        await waitForRewindDisabled(true);
        assert.ok((await rewind.getAttribute('title'))?.includes(explanation));
        assert.equal(await fork.isEnabled(), !('submitting' in patch && patch.submitting));
      }
      await page.evaluate('window.fixture.patch({ submitting: false })');
      await waitForRewindDisabled(false);
      for (const type of ['queue', 'approval']) {
        await page.evaluate(`window.fixture.holdMutation(${JSON.stringify(type)})`);
        await waitForRewindDisabled(true);
        assert.ok(
          (await rewind.getAttribute('title'))?.includes(
            type === 'queue' ? '队列正在更新' : '审批正在提交',
          ),
        );
        await page.evaluate('window.resolveMutation()');
        await waitForRewindDisabled(false);
      }

      // A live status change blocks an already open dialog; a changed tail never expands its boundary.
      await rewind.click();
      await page.evaluate('window.fixture.patch({ submitting: true })');
      await dialog.getByRole('alert').filter({ hasText: '消息正在提交' }).waitFor();
      assert.equal(await confirmRewind.isDisabled(), true);
      await page.evaluate(
        'window.fixture.patch({ submitting: false }); window.fixture.appendMessage()',
      );
      await dialog.getByRole('alert').filter({ hasText: '对话历史已变化' }).waitFor();
      assert.equal(await confirmRewind.isDisabled(), true);
      assert.ok((await dialog.innerText()).includes('后续 2 条消息'));
      await cancelRewind.click();
      assert.equal(
        ((await page.evaluate('window.events')) as unknown[][]).filter(
          (event) => event[0] === 'rewind',
        ).length,
        0,
      );
      await page.evaluate("window.fixture.switch('session-a')");
      await waitForRewindDisabled(false);

      // Rejection stays inline; synchronous repeated confirmations issue exactly one callback.
      await rewind.click();
      await confirmRewind.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await dialog.getByRole('alert').filter({ hasText: '回退接口暂时失败' }).waitFor();
      const rewindEvents = () =>
        page.evaluate('window.events.filter(event => event[0] === "rewind")') as Promise<
          unknown[][]
        >;
      assert.deepEqual(await rewindEvents(), [['rewind', 'session-a', 'user', 'empty']]);
      assert.deepEqual(await readDraft(), beforeRewind);
      assert.equal(await confirmRewind.isEnabled(), true);
      await page.evaluate("window.fixture.rewindMode('hold')");
      await confirmRewind.evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      await dialog.getByRole('status').filter({ hasText: '正在回退对话' }).waitFor();
      assert.equal((await rewindEvents()).length, 2);
      assert.equal(await cancelRewind.isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 1);
      await page.evaluate('window.rejectRewind()');
      await dialog.getByRole('alert').filter({ hasText: '回退接口暂时失败' }).waitFor();
      await page.evaluate("window.fixture.rewindMode('success')");
      await confirmRewind.click();
      await page.waitForFunction(() => document.activeElement?.id === 'prompt-input');
      assert.equal(await dialog.count(), 0);
      assert.equal(await user.count(), 1);
      assert.equal(await assistant.count(), 0);
      assert.equal(await page.locator('[data-message-id="empty"]').count(), 0);
      assert.deepEqual(await readDraft(), beforeRewind);
      assert.equal((await rewindEvents()).length, 3);
      assert.equal(await rewind.count(), 0);
      assert.equal(await fork.count(), 1);

      // Switching sessions while the callback settles cannot reopen the dialog or alter the new draft.
      await page.evaluate("window.fixture.switch('session-a'); window.fixture.rewindMode('hold')");
      await rewind.click();
      await confirmRewind.click();
      await dialog.getByRole('status').filter({ hasText: '正在回退对话' }).waitFor();
      await page.evaluate("window.fixture.switch('session-b')");
      await page.locator('[data-session-id="session-b"]').waitFor();
      await input.focus();
      const otherDraft = await readDraft();
      await page.evaluate('window.resolveRewind()');
      assert.equal(await dialog.count(), 0);
      assert.deepEqual(await readDraft(), otherDraft);
      assert.equal(await input.evaluate((element) => document.activeElement === element), true);
      const steps: Run['plan'] = [
        { content: '检查工作区', status: 'completed' },
        { content: '验证结果', status: 'in_progress' },
        { content: '整理结论', status: 'pending' },
      ];
      const running: Run = { ...run, status: 'running', plan: steps };
      const finished: Run = {
        ...running,
        status: 'completed',
        endedAt: new Date(Date.parse(at) + 10_000).toISOString(),
        plan: steps.map((step) => ({ ...step, status: 'completed' })),
      };
      const setRuns = (runs: Run[], tools: ToolCall[] = []) =>
        page.evaluate(`window.fixture.setRuns(${JSON.stringify(runs)}, ${JSON.stringify(tools)})`);
      const dock = page.locator('.chat-composer .chat-task-plan');
      assert.equal(await dock.count(), 0);
      await page.evaluate("window.fixture.switch('session-a')");
      await setRuns([running]);
      const toggle = dock.getByRole('button', { name: /1 \/ 3 已完成/ });
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.chat-conversation .chat-task-plan').count(), 0);
      const composerBox = page.locator('.chat-composer .composer-box');
      const planBounds = await dock.boundingBox();
      const composerBounds = await composerBox.boundingBox();
      assert.ok(planBounds && composerBounds);
      assert.equal(planBounds.x, composerBounds.x);
      assert.equal(planBounds.width, composerBounds.width);
      assert.ok(composerBounds.y - (planBounds.y + planBounds.height) >= 8);
      assert.notEqual(
        await composerBox.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
        '0px',
      );
      const fade = await page.locator('.chat-composer').evaluate((element) => {
        const style = getComputedStyle(element, '::before');
        return {
          height: style.height,
          pointerEvents: style.pointerEvents,
          paint: style.backgroundImage,
        };
      });
      assert.equal(fade.height, '24px');
      assert.equal(fade.pointerEvents, 'none');
      assert.match(fade.paint, /^linear-gradient/);
      assert.equal(
        await dock.evaluate((element) => element.nextElementSibling?.className),
        'composer-box',
      );
      await toggle.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.press('Space');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      // Remount to exercise the automatic behavior without a manual override.
      await setRuns([]);
      await dock.waitFor({ state: 'detached' });
      await setRuns([running]);
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await setRuns([finished]);
      const finalToggle = dock.getByRole('button', { name: /3 \/ 3 已完成/ });
      await finalToggle.waitFor();
      assert.equal(await finalToggle.getAttribute('aria-expanded'), 'false');
      await finalToggle.press('Enter');
      assert.equal(await dock.getByRole('listitem').count(), 3);
      assert.equal(
        await dock.getByText('验证结果', { exact: true }).evaluate(
          (element) => getComputedStyle(element).textDecorationLine,
        ),
        'none',
      );
      assert.equal(
        await finalToggle.evaluate((element) => document.activeElement === element),
        true,
      );
      const calls: ToolCall[] = Array.from({ length: 17 }, (_, index) => ({
        id: `tool-${index + 1}`,
        runId: run.id,
        sessionId: run.sessionId,
        name: 'Read',
        inputSummary: `file-${index + 1}.txt`,
        status: index < 2 ? 'failed' : 'succeeded',
        output: '',
        startedAt: at,
        endedAt: finished.endedAt,
      }));
      await setRuns([finished, { ...run, id: 'next', status: 'running' }], calls);
      await dock.waitFor({ state: 'detached' });
      const history = assistant.getByRole('button', { name: /已完成 · 用时 10(?:\.0)? 秒/ });
      assert.equal(await history.getAttribute('aria-expanded'), 'false');
      assert.equal(await assistant.getByText('验证结果', { exact: true }).count(), 0);
      await history.press('Enter');
      await assistant.getByText('验证结果', { exact: true }).waitFor();
      assert.equal(await assistant.getByRole('listitem').count(), 3);
      assert.equal(await assistant.locator('.chat-task-plan-toggle').count(), 0);
      assert.equal(await assistant.getByText('工具调用 · 17 次', { exact: true }).count(), 1);
      assert.equal(await assistant.getByText('2 次失败', { exact: true }).count(), 1);
      const callRows = assistant.locator('.run-tool-list [data-tool-id]');
      assert.equal(await callRows.count(), 4);
      assert.equal(await assistant.getByText('已显示 4 / 17 次', { exact: true }).count(), 1);
      await assistant.getByRole('button', { name: '再显示 12 次', exact: true }).press('Enter');
      assert.equal(await callRows.count(), 16);
      await assistant.getByRole('button', { name: '再显示 1 次', exact: true }).click();
      assert.equal(await callRows.count(), 17);
      assert.equal(await assistant.getByText('已显示 17 / 17 次', { exact: true }).count(), 1);
      assert.equal(await assistant.getByRole('button', { name: /再显示/ }).count(), 0);
      await history.press('Space');
      assert.equal(await history.getAttribute('aria-expanded'), 'false');
      await setRuns([finished]);
      await finalToggle.waitFor();
      assert.equal(await finalToggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await dock.getByRole('listitem').count(), 0);
      await page.evaluate("window.fixture.switch('session-b')");
      await page.locator('[data-session-id="session-b"]').waitFor();
      assert.equal(await page.locator('.chat-task-plan').count(), 0);
      await page.setViewportSize({ width: 1440, height: 900 });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
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
