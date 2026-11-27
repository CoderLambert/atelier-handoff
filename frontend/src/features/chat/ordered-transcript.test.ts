/**
 * @file 验证权威对话顺序、运行状态和原消息操作。
 * @implementation 使用顺序模型及加载真实样式的隔离 Chromium 夹具，覆盖历史重试过滤、停止优先、双语续接、反序完成、工具焦点和轮次间距。
 * @updated 2026-11-27T14:21:24+08:00
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { compile } from '@tailwindcss/node';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Run, Message, ToolCall } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { orderedTranscriptRows } from './ordered-transcript-model';

const at = new Date().toISOString();
const run: Run = {
  id: 'run',
  sessionId: 'session',
  projectId: 'project',
  prompt: 'begin',
  status: 'running',
  mode: 'readonly',
  createdAt: at,
  startedAt: at,
  endedAt: null,
  reason: null,
  error: null,
  retryOf: null,
  contextPaths: [],
  attachmentIds: [],
  plan: [],
  usage: null,
  config: { gateway: 'http://fixture.test', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
  transcript: {
    version: 1,
    notices: [{ kind: 'api_retry', order: 6, at, attempt: 1, maxRetries: 3 }],
  },
};
const messages: Message[] = [
  {
    id: 'user',
    sessionId: 'session',
    runId: 'run',
    role: 'user',
    text: 'begin',
    createdAt: at,
    transcriptOrder: 1,
  },
  {
    id: 'assistant',
    sessionId: 'session',
    runId: 'run',
    role: 'assistant',
    text: 'First 🧭\n\nSecond\n\nLast',
    createdAt: at,
    forkAnchor: { sdkSessionId: 'sdk', messageId: 'anchor' },
    transcriptParts: [
      { id: 'first', order: 2, at, start: 0, end: 10 },
      { id: 'second', order: 4, at, start: 10, end: 18 },
      { id: 'last', order: 8, at, start: 18, end: 22 },
    ],
  },
  {
    id: 'insertion',
    sessionId: 'session',
    runId: 'run',
    role: 'user',
    text: 'inserted',
    createdAt: at,
    transcriptOrder: 7,
  },
];
const tool = (id: string, order: number): ToolCall => ({
  id,
  runId: 'run',
  sessionId: 'session',
  name: 'Bash',
  inputSummary: `echo ${id}`,
  status: 'running',
  output: '',
  startedAt: at,
  endedAt: null,
  transcriptOrder: order,
});
const tools = [tool('slow', 3), tool('fast', 5)];
const snapshot: Snapshot = {
  cursor: 0,
  session: {
    id: 'session',
    projectId: 'project',
    title: 'fixture',
    status: 'active',
    sdkSessionId: null,
    createdAt: at,
    updatedAt: at,
    draft: {
      text: '',
      mode: 'readonly',
      contextPaths: [],
      attachmentIds: [],
      extensionSelections: [],
    },
  },
  project: {
    id: 'project',
    name: 'fixture',
    path: '/fixture',
    branch: '',
    available: true,
    createdAt: at,
  },
  runs: [run],
  messages,
  tools,
  permissions: [],
  events: [],
  attachments: [],
  artifacts: [],
  subagents: [],
};

test('transcript keeps native arrival order through reverse tool completion and UTF-16 slices', () => {
  const completed = tools.map((item, index) => ({
    ...item,
    status: 'succeeded' as const,
    endedAt: new Date(Date.parse(at) + (index ? 100 : 200)).toISOString(),
  }));
  const rows = orderedTranscriptRows(run, messages, completed);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.order]),
    [
      ['user', 1],
      ['text', 2],
      ['tool', 3],
      ['text', 4],
      ['tool', 5],
      ['user', 7],
      ['text', 8],
    ],
  );
  const text = rows.flatMap((row) => (row.kind === 'text' ? [row] : []));
  assert.equal(text.map((row) => row.text).join(''), messages[1]?.text);
  assert.deepEqual(
    text.map((row) => row.footer),
    [false, false, true],
  );
  assert.ok(text.every((row) => row.message === messages[1]));
});

test('only adjacent read calls are eligible to fold', () => {
  const read = tools.map((item) => ({ ...item, name: 'Read', status: 'succeeded' as const }));
  assert.equal(
    orderedTranscriptRows(run, messages, read).filter((row) => row.kind === 'tool').length,
    2,
  );
  const firstRead = read[0];
  const secondRead = read[1];
  assert.ok(firstRead && secondRead);
  const adjacent = [firstRead, { ...secondRead, transcriptOrder: 4 }];
  assert.equal(
    orderedTranscriptRows(run, [], adjacent).filter((row) => row.kind === 'tool').length,
    1,
  );
  assert.equal(
    orderedTranscriptRows(
      run,
      [],
      [tools[0], tools[1]].filter((item): item is ToolCall => Boolean(item)),
    ).filter((row) => row.kind === 'tool').length,
    2,
  );
});

const browserPath = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
].find(existsSync);
test(
  'ordered renderer preserves tool focus, full-message actions and live status in both languages',
  { skip: !browserPath, timeout: 60000 },
  async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const compiled = await build({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        loader: 'tsx',
        contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { Conversation } from '@/features/chat/conversation';
    import { uiI18n } from '@/i18n';
    let snapshot = ${JSON.stringify(snapshot)};
    const root = createRoot(document.getElementById('app')); const client = new QueryClient();
    window.actions = []; window.copies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.copies.push(text) } });
    let stopPendingRunId;
    function render() { root.render(<QueryClientProvider client={client}><Conversation snapshot={snapshot} stopPendingRunId={stopPendingRunId} onRetry={()=>{}} onTrace={()=>{}} onForkMessage={id => window.actions.push(id)} submitting={false}/></QueryClientProvider>); }
    window.fixture = {
      waiting: () => { snapshot = {...snapshot, events: [...snapshot.events, {id:2,runId:'run',sessionId:'session',seq:2,type:'sdk.initialized',at:${JSON.stringify(at)},payload:{}}], runs:snapshot.runs.map(run => ({...run,status:'running',endedAt:null,transcript:{version:1,notices:[]}}))}; render(); },
      retry: (status, pending = false) => { stopPendingRunId = pending ? 'run' : undefined; snapshot = {...snapshot, tools:[], events:[{id:3,runId:'run',sessionId:'session',seq:3,type:'sdk.api_retry',at:${JSON.stringify(at)},payload:{}}], runs:snapshot.runs.map(current => ({...${JSON.stringify(run)},status,endedAt:status === 'stopped' ? ${JSON.stringify(at)} : null}))}; render(); },
      finishFast: () => { snapshot = {...snapshot, tools: snapshot.tools.map(tool => tool.id === 'fast' ? {...tool, status:'succeeded', endedAt: new Date().toISOString(), output:'done'} : tool)}; render(); },
      finish: () => { snapshot = {...snapshot, runs: snapshot.runs.map(run => ({...run,status:'completed',endedAt:new Date().toISOString()})), tools: snapshot.tools.map(tool => ({...tool,status:'succeeded',endedAt:new Date().toISOString()}))}; render(); },
      locale: locale => uiI18n.changeLanguage(locale),
      reads: (status, prefix = 'read') => { snapshot = {...snapshot, tools: [9,10].map((order,index) => ({...${JSON.stringify(tools[0])}, id:prefix+'-'+index, name:'Read', status, transcriptOrder:order}))}; render(); },
      restoreContext: () => { snapshot = {...snapshot, session: {...snapshot.session, fork: {sourceSessionId:'source', sourceMessageId:'anchor', sourceTitle:'Source'}}, events: [{id:1,runId:'run',sessionId:'session',seq:1,type:'sdk.context_restarted',at:${JSON.stringify(at)},payload:{}}]}; render(); },
      notice: kind => { const {transcriptOrder, ...hookOnly} = snapshot.tools[0]; snapshot = {...snapshot, tools:[{...hookOnly,id:'pending',name:'Bash',status:'running'}], runs:snapshot.runs.map(run => ({...run,status:'running',endedAt:null,transcript:{version:1,notices:[{kind,toolCallId:'pending',toolName:'Bash',order:11,at:${JSON.stringify(at)}}]}}))}; render(); },
      actualTool: () => { snapshot = {...snapshot, tools:snapshot.tools.map(tool => ({...tool,transcriptOrder:11})), runs:snapshot.runs.map(run => ({...run,transcript:{version:1,notices:[]}}))}; render(); },
      spacing: (status, nextLegacy, hasText) => {
        const previous = {...${JSON.stringify(run)}, status, endedAt:${JSON.stringify(at)}};
        const next = {...previous, id:'next', prompt:'next message', status:'running', endedAt:null, transcript:nextLegacy ? undefined : {version:1, notices:[]}};
        snapshot = {...snapshot, runs:[previous,next], tools:[], events:[], messages:[
          {...${JSON.stringify(messages[0])}, id:'previous-user'},
          ...(hasText ? [{...${JSON.stringify(messages[1])}, id:'previous-assistant'}] : []),
          {...${JSON.stringify(messages[0])}, id:'next-user', runId:'next', text:'next message'}
        ]}; render();
      },
    }; render();
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
    const styles = utilities.build([]);
    const server = createServer((request, response) => {
      if (request.url === '/bundle.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(bundle);
      } else
        response.end(
          `<!doctype html><html><head><style>${styles}</style></head><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>`,
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
      await page.locator('[data-run-live-status]').waitFor();
      assert.deepEqual(
        await page
          .locator('[data-transcript-order]')
          .evaluateAll((nodes) =>
            nodes.map((node) => [
              node.getAttribute('data-transcript-kind'),
              Number(node.getAttribute('data-transcript-order')),
            ]),
          ),
        [
          ['user', 1],
          ['text', 2],
          ['tool', 3],
          ['text', 4],
          ['tool', 5],
          ['user', 7],
          ['text', 8],
        ],
      );
      assert.equal(
        await page.locator('[data-transcript-part-id="last"][data-last-message="true"]').count(),
        1,
      );
      assert.equal(
        await page.locator('[data-transcript-part-id="first"][data-last-message]').count(),
        0,
      );
      await page.evaluate('window.fixture.restoreContext()');
      await page
        .locator('[data-transcript-kind="user"]')
        .first()
        .getByText('本轮使用该分支的历史正文恢复上下文。', { exact: true })
        .waitFor();
      const slow = page.locator('[data-tool-id="slow"] > summary');
      await slow.focus();
      await page.evaluate('window.fixture.finishFast()');
      assert.equal(await slow.evaluate((node) => node === document.activeElement), true);
      assert.equal(
        await page
          .locator('[data-tool-id="fast"] .tool-detail__status[data-status="succeeded"]')
          .count(),
        1,
      );
      assert.equal(await page.locator('[data-message-id="assistant"] .message-actions').count(), 1);
      await page.getByRole('button', { name: '复制 Markdown', exact: true }).click();
      assert.deepEqual(await page.evaluate('window.copies'), [messages[1]?.text]);
      await page.getByRole('button', { name: '从这里分支', exact: true }).click();
      assert.deepEqual(await page.evaluate('window.actions'), ['assistant']);
      const elapsed = await page.locator('[data-run-elapsed]').textContent();
      await page.waitForTimeout(1200);
      assert.notEqual(await page.locator('[data-run-elapsed]').textContent(), elapsed);
      await page.evaluate('window.fixture.locale("en")');
      assert.equal(await page.locator('[data-transcript-notice-kind="api_retry"]').count(), 0);
      assert.match(await page.locator('[data-run-live-status]').innerText(), /Calling Bash/);
      await page.evaluate('window.fixture.finish()');
      await page.locator('[data-transcript-kind="summary"]').waitFor();
      assert.equal(await page.locator('[data-run-live-status]').count(), 0);
      assert.equal(await page.locator('[data-transcript-kind="summary"] button').count(), 1);
      await page.evaluate('window.fixture.waiting()');
      const liveStatus = page.locator(
        '#conversation-content .ordered-run > .transcript-run-end:last-child > [data-run-live-status]:last-child',
      );
      await liveStatus.getByText('Waiting for the model to reply', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-run-live-status]').count(), 1);
      await page.evaluate('window.fixture.locale("zh-CN")');
      await liveStatus.getByText('正在等待模型回复', { exact: true }).waitFor();
      await page.evaluate('window.fixture.retry("running")');
      await liveStatus.getByText('等待模型重试结果', { exact: true }).waitFor();
      await page.evaluate('window.fixture.retry("running", true)');
      await page.locator('[data-run-live-status][data-status="stopping"]').waitFor();
      assert.equal(await liveStatus.getByText('等待模型重试结果', { exact: true }).count(), 0);
      await page.evaluate('window.fixture.retry("running")');
      await liveStatus.getByText('等待模型重试结果', { exact: true }).waitFor();
      await page.evaluate('window.fixture.retry("stopping")');
      await page.locator('[data-run-live-status][data-status="stopping"]').waitFor();
      await page.evaluate('window.fixture.retry("stopped")');
      await page.getByRole('button', { name: '只读续接', exact: true }).waitFor();
      assert.equal(await page.locator('[data-run-live-status], [data-transcript-notice-kind="api_retry"]').count(), 0);
      await page.evaluate('window.fixture.locale("en")');
      await page.getByRole('button', { name: 'Resume read-only', exact: true }).waitFor();
      await page.evaluate('window.fixture.waiting()');
      await page.evaluate('window.fixture.reads("running")');
      const firstRead = page.locator('[data-tool-id="read-0"] > summary');
      await firstRead.focus();
      await page.evaluate('window.fixture.reads("succeeded")');
      assert.equal(await firstRead.evaluate((node) => node === document.activeElement), true);
      assert.equal(await firstRead.isVisible(), true);
      await page
        .getByRole('button', { name: '2 reads and searches completed', exact: true })
        .click();
      assert.equal(await firstRead.isVisible(), false);
      await page
        .getByRole('button', { name: '2 reads and searches completed', exact: true })
        .click();
      assert.equal(await firstRead.isVisible(), true);
      await page.evaluate('window.fixture.reads("failed")');
      await page
        .locator('[data-tool-id="read-0"] .tool-detail__status[data-status="failed"]')
        .waitFor();
      assert.equal(
        await page
          .getByRole('button', { name: '2 reads and searches completed', exact: true })
          .count(),
        0,
      );
      assert.equal(await firstRead.isVisible(), true);
      await page.evaluate('window.fixture.reads("succeeded", "fresh-mouse")');
      const mouseRead = page.locator('[data-tool-id="fresh-mouse-0"] > summary');
      const toggle = page.getByRole('button', {
        name: '2 reads and searches completed',
        exact: true,
      });
      await mouseRead.waitFor({ state: 'attached' });
      await toggle.waitFor();
      assert.equal(await mouseRead.isVisible(), false);
      await toggle.click();
      assert.equal(await mouseRead.isVisible(), true);
      await page.evaluate('window.fixture.reads("succeeded", "fresh-keyboard")');
      const keyboardRead = page.locator('[data-tool-id="fresh-keyboard-0"] > summary');
      await keyboardRead.waitFor({ state: 'attached' });
      await toggle.waitFor();
      await toggle.focus();
      assert.equal(await keyboardRead.isVisible(), false);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.press('Enter');
      assert.equal(await keyboardRead.isVisible(), true);
      await page.evaluate('window.fixture.restoreContext()');
      await page
        .getByText('Context for this turn was restored from this branch’s message history.', {
          exact: true,
        })
        .first()
        .waitFor();
      await page.evaluate('window.fixture.notice("tool_interrupted")');
      await page.getByText('Bash stopped before starting', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-tool-id="pending"]').count(), 0);
      assert.match(await page.locator('[data-run-live-status]').innerText(), /Calling Bash/);
      await page.evaluate('window.fixture.locale("zh-CN")');
      await page.getByText('Bash 已在启动前停止', { exact: true }).waitFor();
      await page.evaluate('window.fixture.notice("tool_preparing")');
      await page.getByText('正在准备 Bash', { exact: true }).waitFor();
      await page.evaluate('window.fixture.locale("en")');
      await page.getByText('Preparing Bash', { exact: true }).waitFor();
      assert.equal(
        await page.locator('[data-transcript-notice-kind="tool_preparing"] button').count(),
        0,
      );
      await page.evaluate(() => {
        (window as Window & { noticeRow?: Element }).noticeRow =
          document.querySelector('[data-transcript-notice-kind="tool_preparing"]')?.parentElement ??
          undefined;
      });
      await page.evaluate('window.fixture.actualTool()');
      await page.locator('[data-tool-id="pending"]').waitFor();
      assert.equal(await page.locator('[data-transcript-notice-kind="tool_preparing"]').count(), 0);
      assert.equal(
        await page
          .locator('[data-tool-id="pending"]')
          .evaluate(
            (node) =>
              node.closest('.transcript-tools')?.parentElement ===
              (window as Window & { noticeRow?: Element }).noticeRow,
          ),
        true,
      );
      assert.equal(
        await page.locator('[data-transcript-kind="tool"][data-transcript-order="11"]').count(),
        1,
      );
      for (const status of ['stopped', 'failed', 'interrupted', 'completed']) {
        for (const nextLegacy of [false, true]) {
          for (const hasText of [false, true]) {
            await page.evaluate(
              `window.fixture.spacing(${JSON.stringify(status)}, ${nextLegacy}, ${hasText})`,
            );
            const next = page.locator('[data-message-id="next-user"] .user-message-bubble');
            await next.waitFor();
            const gap = await next.evaluate((bubble) => {
              const previous = document.querySelector('.message-thread > .ordered-run');
              if (!previous) throw new Error('Previous ordered run missing');
              return bubble.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
            });
            assert.equal(gap, 24, `${status}, legacy=${nextLegacy}, text=${hasText}`);
          }
        }
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
