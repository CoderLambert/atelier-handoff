/**
 * @file 验证子任务的分组、历史展开、实时刷新和审批来源。
 * @implementation 在隔离浏览器和回环 API 中检查子任务的归属、进展记录、单分支停止及审批入口。
 * @updated 2026-11-22T16:22:55+08:00
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import type { Snapshot } from '@/api/types';
import type { Subagent } from '@shared/subagents';
import type { Permission, Run, ToolCall } from '@shared/types';
import { groupRunWork, permissionSubagentSource } from './subagent-progress';
import { permissionSchema } from '@/use-query/permissions/use-permission';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { stopSubagentOptions } from '@/use-query/runs/use-stop-subagent';
import { sessionKeys } from '@/use-query/sessions/keys';
import { runKeys } from '@/use-query/runs/keys';

const startedAt = '2026-11-20T10:00:00.000Z';
const endedAt = '2026-11-20T10:00:12.000Z';
function run(id = 'active', status: Run['status'] = 'running', sessionId = 'session-a'): Run {
  return {
    id,
    sessionId,
    projectId: 'project',
    prompt: id,
    status,
    mode: 'edit',
    createdAt: startedAt,
    startedAt,
    endedAt: status === 'running' ? null : endedAt,
    reason: null,
    error: null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config: { gateway: 'http://fixture.test', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
  };
}
function subagent(id: string, runId = 'active', status: Subagent['status'] = 'running'): Subagent {
  return {
    id,
    runId,
    sessionId: 'session-a',
    kind: 'worker',
    title: `任务 ${id}`,
    status,
    summary: status === 'running' ? null : `结果 ${id}`,
    startedAt,
    endedAt: status === 'running' ? null : endedAt,
  };
}
function tool(id: string, subagentId?: string): ToolCall {
  return {
    id,
    subagentId,
    runId: 'active',
    sessionId: 'session-a',
    name: `tool_${id}`,
    inputSummary: `参数 ${id}`,
    status: 'succeeded',
    output: `输出 ${id}`,
    startedAt,
    endedAt,
  };
}
function approval(id = 'approval', subagentId: string | undefined = 'worker'): Permission {
  return {
    id,
    runId: 'active',
    sessionId: 'session-a',
    toolCallId: 'child-tool',
    subagentId,
    kind: 'command',
    path: null,
    command: 'printf fixture',
    before: null,
    after: null,
    diff: '',
    baseFingerprint: null,
    version: 'version-1',
    status: 'pending',
    createdAt: startedAt,
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    reason: '合成测试操作',
  };
}
function snapshot(): Snapshot {
  const runs = [run('old', 'completed'), run()];
  return {
    session: {
      id: 'session-a',
      projectId: 'project',
      title: '合成会话 A',
      status: 'active',
      sdkSessionId: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      draft: { text: '', mode: 'edit', contextPaths: [], attachmentIds: [] },
    },
    project: {
      id: 'project',
      name: 'Fixture',
      path: '/fixture',
      branch: '',
      available: true,
      createdAt: startedAt,
    },
    runs,
    messages: runs.flatMap((item) => [
      {
        id: `user-${item.id}`,
        runId: item.id,
        sessionId: item.sessionId,
        role: 'user' as const,
        text: item.prompt,
        createdAt: startedAt,
      },
      {
        id: `reply-${item.id}`,
        runId: item.id,
        sessionId: item.sessionId,
        role: 'assistant' as const,
        text: `回复 ${item.id}`,
        createdAt: startedAt,
      },
    ]),
    tools: [tool('main-tool'), tool('child-tool', 'worker')],
    subagents: [subagent('old-worker', 'old', 'completed'), subagent('worker'), subagent('peer')],
    permissions: [approval()],
    artifacts: [],
    attachments: [],
    events: [
      {
        id: 1,
        runId: 'active',
        sessionId: 'session-a',
        seq: 1,
        type: 'harness.progress',
        at: startedAt,
        payload: { kind: 'stalled', summary: '连续搜索没有新增证据，正在调整任务。' },
      },
    ],
    cursor: 0,
  };
}

test('subtask grouping preserves legacy snapshots, infers tool approval ownership, and isolates session and run', () => {
  const value = snapshot();
  const active = value.runs[1];
  assert.ok(active);
  const inferred = approval('inferred');
  delete inferred.subagentId;
  value.permissions = [inferred];
  value.subagents?.push({ ...subagent('foreign'), sessionId: 'session-b' });
  value.tools.push({ ...tool('foreign-tool', 'foreign'), sessionId: 'session-b' });
  value.permissions.push({ ...approval('foreign-approval', 'foreign'), sessionId: 'session-b' });
  const grouped = groupRunWork(value, active);
  assert.deepEqual(
    grouped.tools.map((item) => item.id),
    ['main-tool'],
  );
  assert.deepEqual(
    grouped.subagents.map((item) => item.id),
    ['worker', 'peer'],
  );
  assert.deepEqual(
    grouped.subagents[0]?.tools.map((item) => item.id),
    ['child-tool'],
  );
  assert.deepEqual(
    grouped.subagents[0]?.permissions.map((item) => item.id),
    ['inferred'],
  );
  assert.deepEqual(permissionSubagentSource(value, inferred), {
    id: 'worker',
    title: '任务 worker',
  });
  assert.equal(
    permissionSubagentSource(value, { ...approval(), sessionId: 'session-b' }),
    undefined,
  );
  const legacy = { ...value, subagents: undefined, tools: [tool('legacy')], permissions: [] };
  assert.deepEqual(groupRunWork(legacy, active).subagents, []);
  assert.deepEqual(groupRunWork(value, { ...active, sessionId: 'session-b' }).subagents, []);
  const orphan = { ...value, subagents: undefined };
  assert.equal(groupRunWork(orphan, active).subagents[0]?.id, 'worker');
  assert.deepEqual(permissionSubagentSource(orphan, inferred), { id: 'worker', title: 'worker' });
});

test('permission parser retains subagent provenance and accepts old approvals', () => {
  assert.equal(permissionSchema.parse(approval()).subagentId, 'worker');
  const legacy = approval();
  delete legacy.subagentId;
  assert.equal(permissionSchema.parse(legacy).subagentId, undefined);
  assert.throws(() => permissionSchema.parse({ ...legacy, subagentId: 12 }));
});

test('subtask stop scopes encoded identifiers and refreshes its snapshot and trace only after a valid acknowledgment', async (t) => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0 }, mutations: { gcTime: 0 } },
  });
  const value = { id: 'run/active', sessionId: 'session/a' };
  const snapshotKey = sessionKeys.snapshot(value.sessionId);
  const traceKey = runKeys.trace(value.id);
  const other = sessionKeys.snapshot('session/b');
  client.setQueryData(snapshotKey, {});
  client.setQueryData(traceKey, {});
  client.setQueryData(other, {});
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    attempts++;
    assert.equal(String(input), '/api/runs/run%2Factive/subagents/child%2Fone/stop');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, '{}');
    return Response.json(attempts === 1 ? { ok: false } : { ok: true });
  });
  try {
    const stop = new MutationObserver(client, stopSubagentOptions(value, client));
    await assert.rejects(stop.mutate('child/one'));
    assert.equal(attempts, 1);
    assert.equal(client.getQueryState(snapshotKey)?.isInvalidated, false);
    await stop.mutate('child/one');
    assert.equal(client.getQueryState(snapshotKey)?.isInvalidated, true);
    assert.equal(client.getQueryState(traceKey)?.isInvalidated, true);
    assert.equal(client.getQueryState(other)?.isInvalidated, false);
  } finally {
    client.clear();
  }
});

const browserPath = [
  process.env.ATELIER_TEST_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));

test(
  'React subtask UI preserves independent historical expansion through SSE completion and uses scoped approval dialogs',
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
        import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
        import { Conversation } from '@/features/chat/conversation';
        import { RunTrace } from '@/features/inspector/run-trace';
        import { useRunEvents, keys } from '@/app/events';
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
        const root = createRoot(document.getElementById('app'));
        function App({ sessionId, view }) {
          useRunEvents(client, 0);
          const { data } = useQuery({ queryKey: keys.snapshot(sessionId), queryFn: () => fetch('/snapshot/' + sessionId).then(r => r.json()) });
          if (!data) return null;
          return view === 'trace'
            ? <RunTrace snapshot={data} runId="active" onSelect={() => {}} />
            : <Conversation key={sessionId} snapshot={data} onRetry={() => {}} onTrace={() => {}} submitting={false} />;
        }
        window.renderFixture = (sessionId = 'session-a', view = 'chat') => root.render(<QueryClientProvider client={client}><App sessionId={sessionId} view={view} /></QueryClientProvider>);
        window.renderFixture();
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
    let current = snapshot();
    const streams = new Set<ServerResponse>();
    const requests: string[] = [];
    const decisions: unknown[] = [];
    let seq = 1;
    let stopAttempts = 0;
    const server = createServer(async (req, res) => {
      const path = req.url ?? '/';
      requests.push(path);
      if (path.startsWith('/api/events')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': connected\n\n');
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (path === '/api/bootstrap') return void res.end(JSON.stringify({ csrfToken: 'fixture' }));
      if (path === '/api/runs/active/subagents/peer/stop') {
        assert.equal(req.method, 'POST');
        let body = '';
        for await (const part of req) body += String(part);
        assert.equal(body, '{}');
        stopAttempts++;
        if (stopAttempts === 1) {
          res.statusCode = 503;
          return void res.end(JSON.stringify({ error: { message: '合成子任务停止失败' } }));
        }
        current = {
          ...current,
          subagents: current.subagents?.map((item) =>
            item.id === 'peer' ? { ...item, status: 'stopped', endedAt } : item,
          ),
        };
        return void res.end(JSON.stringify({ ok: true }));
      }
      if (path.startsWith('/snapshot/')) {
        const value =
          path === '/snapshot/session-a'
            ? current
            : {
                ...snapshot(),
                session: { ...snapshot().session, id: 'session-b' },
                runs: [run('other', 'completed', 'session-b')],
                messages: [
                  {
                    id: 'other-reply',
                    runId: 'other',
                    sessionId: 'session-b',
                    role: 'assistant',
                    text: '其他会话',
                    createdAt: startedAt,
                  },
                ],
                subagents: [
                  { ...subagent('other-worker', 'other', 'completed'), sessionId: 'session-b' },
                ],
                tools: [],
                permissions: [],
              };
        return void res.end(JSON.stringify(value));
      }
      if (path.endsWith('/trace'))
        return void res.end(
          JSON.stringify({ events: current.events, eventCount: current.events.length }),
        );
      if (path.startsWith('/api/permissions/')) {
        const permission = current.permissions[0];
        assert.ok(permission);
        if (path.endsWith('/decision')) {
          let body = '';
          for await (const part of req) body += String(part);
          decisions.push(JSON.parse(body));
          current = { ...current, permissions: [{ ...permission, status: 'allowed' }] };
          return void res.end(JSON.stringify({ permission: current.permissions[0] }));
        }
        return void res.end(JSON.stringify(path.endsWith('/diff') ? permission : { permission }));
      }
      if (path === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return void res.end(bundle);
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Subtask test</title></head><body><div id="app"></div><script type="module" src="/bundle.js"></script></body></html>',
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
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      const old = page.locator('[data-subagent-id="old-worker"]');
      const worker = page.locator('[data-subagent-id="worker"]');
      const peer = page.locator('[data-subagent-id="peer"]');
      await old.locator('summary').first().click();
      assert.match(await old.innerText(), /结果 old-worker/);
      await worker.locator('summary').first().click();
      assert.equal(await peer.getAttribute('open'), null);
      assert.equal(await worker.locator('[data-tool-id="main-tool"]').count(), 0);
      await worker.locator('[data-tool-id="child-tool"] > summary').click();
      assert.match(await worker.innerText(), /输出 child-tool/);
      assert.equal(await page.getByRole('button', { name: '查看并审批', exact: true }).count(), 1);
      await worker.getByRole('button', { name: '查看并审批', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText('子代理 · 任务 worker', { exact: true }).waitFor();
      const allow = dialog.getByRole('button', { name: '允许本次操作', exact: true });
      await allow.waitFor();
      await allow.click();
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      assert.deepEqual(decisions, [{ decision: 'allow', version: 'version-1' }]);
      assert.equal(await old.getByRole('button', { name: /停止子任务/ }).count(), 0);
      await peer.locator('summary').first().click();
      await peer.getByRole('button', { name: '停止子任务 任务 peer', exact: true }).click();
      await peer
        .getByRole('alert')
        .getByText('请求未完成，请稍后重试。', { exact: true })
        .waitFor();
      await peer.getByRole('button', { name: '停止子任务 任务 peer', exact: true }).click();
      await peer.locator('summary').getByText('已停止', { exact: true }).waitFor();
      assert.equal(stopAttempts, 2);
      assert.equal(await peer.getByRole('button', { name: /停止子任务/ }).count(), 0);
      assert.equal(await worker.getByRole('button', { name: /停止子任务/ }).count(), 1);
      await peer.locator('summary').first().click();

      function emit(type: string, sessionId = 'session-a') {
        const event = {
          id: ++seq,
          runId: 'active',
          sessionId,
          seq,
          type,
          at: endedAt,
          payload: {},
        };
        for (const stream of streams)
          stream.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      const finished = [
        ['completed', '已完成'],
        ['failed', '失败'],
        ['stopped', '已停止'],
        ['interrupted', '已中断'],
      ] as const;
      for (const [status, label] of finished) {
        current = {
          ...current,
          runs: current.runs.map((item) =>
            item.id === 'active' ? { ...item, status: 'completed', endedAt } : item,
          ),
          subagents: current.subagents?.map((item) =>
            item.id === 'worker' ? { ...item, status, endedAt, summary: `终态 ${status}` } : item,
          ),
        };
        emit('subagent.finished');
        await worker.getByText(`终态 ${status}`, { exact: true }).waitFor();
        assert.equal(await worker.getAttribute('open'), '');
        assert.equal(await old.getAttribute('open'), '');
        assert.equal(await peer.getAttribute('open'), null);
        const summary = await worker.locator('summary').first().innerText();
        assert.match(summary, /12\.0 秒/);
        assert.ok(summary.includes(label));
      }
      // A start event alone refreshes the same session snapshot through the existing event adapter.
      current = {
        ...current,
        subagents: [...(current.subagents ?? []), subagent('new', 'active')],
      };
      emit('subagent.started');
      await page.locator('[data-subagent-id="new"]').waitFor();
      assert.equal(await page.locator('[data-subagent-id="worker"]').count(), 1);
      await page.evaluate("window.renderFixture('session-b')");
      await page.locator('[data-subagent-id="other-worker"]').waitFor();
      assert.equal(await worker.count(), 0);
      emit('subagent.finished');
      assert.equal(await page.locator('[data-subagent-id="worker"]').count(), 0);
      await page.evaluate("window.renderFixture('session-a', 'trace')");
      await page.getByRole('heading', { name: '主助手工具', exact: true }).waitFor();
      const traceWorker = page.locator('[data-subagent-id="worker"]');
      await traceWorker.locator('summary').first().click();
      assert.equal(await traceWorker.locator('[data-tool-id="child-tool"]').count(), 1);
      assert.equal(await traceWorker.locator('[data-tool-id="main-tool"]').count(), 0);
      await traceWorker.getByRole('button', { name: '查看审批记录', exact: true }).click();
      await page.getByRole('dialog').getByText('子代理 · 任务 worker', { exact: true }).waitFor();
      assert.ok(requests.some((path) => path === '/api/runs/active/trace'));
      assert.equal(requests.filter((path) => path.includes('/subagents')).length, 2);
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      await page
        .getByText('进展停滞 · 连续搜索没有新增证据，正在调整任务。', { exact: true })
        .waitFor();
      await page
        .getByRole('combobox', { name: '筛选事件类型', exact: true })
        .selectOption('harness');
      const progressEvents = page.locator('details[data-event-type="harness.progress"]');
      assert.equal(await progressEvents.count(), 1);
      await progressEvents.locator(':scope > summary').click();
      await progressEvents.locator('pre').filter({ hasText: 'harness.progress' }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
