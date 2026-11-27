/**
 * @file 验证会话消息队列的前端契约、操作和展示。
 * @implementation 使用传输替身、独立 QueryClient 和静态渲染检查插入、恢复与复核请求、状态展示、正文展开及会话精准刷新。
 * @updated 2026-11-27T02:25:28+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Run, SessionMessageQueue } from '@shared/types';
import { ApiError } from '@/api/client';
import { actions, store } from '@/app/store';
import { emptyDraft } from '@/app/drafts';
import { sessionKeys } from '@/use-query/sessions/keys';
import { sendSessionMessage } from '@/use-query/sessions/use-send-session-message';
import { resumeMessageQueueOptions } from '@/use-query/sessions/use-resume-message-queue';
import { withdrawQueuedMessageOptions } from '@/use-query/sessions/use-withdraw-queued-message';
import { insertQueuedMessageOptions } from '@/use-query/sessions/use-insert-queued-message';
import { MessageQueue } from './message-queue';

const makeClient = () =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: 0 }, mutations: { gcTime: 0 } },
  });

const queue: SessionMessageQueue = {
  paused: true,
  items: [
    { id: 'item/1', text: 'First <task>', createdAt: 'now', error: 'Dependency unavailable' },
    { id: 'item/2', text: 'Second task', createdAt: 'later', error: null },
  ],
};

const activeRun: Run = {
  id: 'run/active',
  sessionId: 'session',
  projectId: 'project',
  prompt: 'Current task',
  status: 'running',
  mode: 'edit',
  createdAt: 'now',
  startedAt: 'now',
  endedAt: null,
  reason: null,
  error: null,
  retryOf: null,
  contextPaths: [],
  attachmentIds: [],
  plan: [],
  usage: null,
  config: { gateway: 'http://localhost', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
};

function renderQueue(value: SessionMessageQueue, archived = false, available = true, run?: Run) {
  const client = makeClient();
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageQueue, {
          sessionId: 'session',
          queue: value,
          archived,
          available,
          activeRun: run,
        }),
      ),
    );
  } finally {
    client.clear();
  }
}

test('send transport accepts a queued response and preserves its retained extension metadata', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    assert.equal(String(input), '/api/sessions/session%2FA/messages');
    assert.equal(init?.method, 'POST');
    return Response.json({
      queuedMessage: {
        ...queue.items[0],
        extensions: [{ id: 'skill', version: 3, kind: 'skill', name: 'Retained skill' }],
      },
    });
  });
  const result = await sendSessionMessage({
    sessionId: 'session/A',
    body: { ...emptyDraft(), text: 'queued', idempotencyKey: 'same-submission' },
  });
  assert.equal(result.run, undefined);
  assert.equal(result.queuedMessage?.id, 'item/1');
  assert.equal(result.queuedMessage?.extensions?.[0]?.version, 3);
});

test('withdraw and resume encode identifiers and refresh only their originating session snapshot', async (t) => {
  const client = makeClient();
  const id = 'session/A';
  const origin = sessionKeys.snapshot(id);
  const other = sessionKeys.snapshot('session/B');
  const requests: { path: string; method?: string; body?: BodyInit | null }[] = [];
  const originalDraft = { ...emptyDraft('edit'), text: 'still editing' };
  store.dispatch(actions.setDraft({ id, draft: originalDraft }));
  store.dispatch(actions.setSearchChargeLimit({ id, value: '25' }));
  client.setQueryData(origin, { messageQueue: queue });
  client.setQueryData(other, { messageQueue: queue });
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    requests.push({ path: String(input), method: init?.method, body: init?.body });
    return Response.json({ ok: true });
  });
  try {
    const withdraw = new MutationObserver(client, withdrawQueuedMessageOptions(client, id));
    await withdraw.mutate('item/1');
    assert.equal(client.getQueryState(origin)?.isInvalidated, true);
    assert.equal(client.getQueryState(other)?.isInvalidated, false);
    client.setQueryData(origin, { messageQueue: queue });
    const resume = new MutationObserver(client, resumeMessageQueueOptions(client, id));
    await resume.mutate(undefined);
    assert.equal(client.getQueryState(origin)?.isInvalidated, true);
    assert.equal(client.getQueryState(other)?.isInvalidated, false);
    await resume.mutate('item/1');
    assert.deepEqual(requests, [
      {
        path: '/api/sessions/session%2FA/message-queue/item%2F1',
        method: 'DELETE',
        body: undefined,
      },
      { path: '/api/sessions/session%2FA/message-queue/resume', method: 'POST', body: '{}' },
      {
        path: '/api/sessions/session%2FA/message-queue/resume',
        method: 'POST',
        body: JSON.stringify({ reviewItemId: 'item/1' }),
      },
    ]);
    assert.deepEqual(store.getState().workspace.drafts[id], originalDraft);
    assert.equal(store.getState().workspace.searchChargeLimits[id], '25');
  } finally {
    store.dispatch(actions.dropDraft(id));
    client.clear();
  }
});

test('withdraw conflict refreshes authoritative snapshot without dropping the pending item locally or retrying', async (t) => {
  const client = makeClient();
  const origin = sessionKeys.snapshot('origin');
  const other = sessionKeys.snapshot('other');
  client.setQueryData(origin, { messageQueue: queue });
  client.setQueryData(other, { messageQueue: queue });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    requests++;
    return Response.json({ error: { message: 'Already started' } }, { status: 409 });
  });
  try {
    const mutation = new MutationObserver(client, withdrawQueuedMessageOptions(client, 'origin'));
    await assert.rejects(mutation.mutate('item/1'), /Already started/);
    assert.equal(requests, 1);
    assert.equal(client.getQueryState(origin)?.isInvalidated, true);
    assert.equal(client.getQueryState(other)?.isInvalidated, false);
    assert.deepEqual(client.getQueryData(origin), { messageQueue: queue });
  } finally {
    client.clear();
  }
});

test('resume rejects malformed acknowledgments and keeps the queue for retry', async (t) => {
  const client = makeClient();
  const origin = sessionKeys.snapshot('origin');
  client.setQueryData(origin, { messageQueue: queue });
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    return Response.json({ ok: false });
  });
  try {
    const mutation = new MutationObserver(client, resumeMessageQueueOptions(client, 'origin'));
    await assert.rejects(mutation.mutate(undefined));
    assert.equal(client.getQueryState(origin)?.isInvalidated, true);
    assert.deepEqual(client.getQueryData(origin), { messageQueue: queue });
  } finally {
    client.clear();
  }
});

test('queue renders FIFO text, full-text disclosure, errors, withdraw and paused resume controls', () => {
  const markup = renderQueue(queue);
  assert.match(markup, /待处理消息 · 2 · 已暂停/);
  assert.match(markup, /继续队列/);
  assert.match(markup, /Dependency unavailable/);
  assert.match(markup, /<details>/);
  assert.match(markup, /First &lt;task&gt;/);
  assert.ok(markup.indexOf('First &lt;task&gt;') < markup.indexOf('Second task'));
  assert.match(markup, /aria-label="撤回消息 1"/);
  assert.match(markup, /aria-label="撤回消息 2"/);
  assert.equal(renderQueue({ items: [], paused: false }), '');
  assert.doesNotMatch(renderQueue({ ...queue, paused: false }), /继续队列/);
  assert.match(renderQueue(queue, true), /disabled=""[^>]*>继续队列/);
  assert.match(renderQueue(queue, false, false), /disabled=""[^>]*>继续队列/);
});

test('authorization changes surface review in place of ordinary queue resume', () => {
  const markup = renderQueue({
    paused: true,
    items: [
      {
        id: 'scope-item',
        text: 'Pending task',
        createdAt: 'now',
        error: 'Legacy error',
        scopeChanged: true,
      },
    ],
  });
  assert.match(markup, /复核并继续/);
  assert.match(markup, /排队时的授权范围已变化，请复核后继续/);
  assert.doesNotMatch(markup, /Legacy error|>继续队列</);
});

test('insert posts encoded queue identifiers and exact live or priority intent, refreshing only its session', async (t) => {
  const client = makeClient();
  const origin = sessionKeys.snapshot('session/A');
  const other = sessionKeys.snapshot('session/B');
  const originalDraft = { ...emptyDraft('edit'), text: 'Keep editing' };
  store.dispatch(actions.setDraft({ id: 'session/A', draft: originalDraft }));
  store.dispatch(actions.setSearchChargeLimit({ id: 'session/A', value: '25' }));
  client.setQueryData(other, { messageQueue: queue });
  const requests: { path: string; method?: string; body?: BodyInit | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    requests.push({ path: String(input), method: init?.method, body: init?.body });
    return Response.json({ ok: true });
  });
  try {
    const insert = new MutationObserver(client, insertQueuedMessageOptions(client, 'session/A'));
    for (const mode of ['live', 'priority'] as const) {
      client.setQueryData(origin, { messageQueue: queue });
      await insert.mutate({ itemId: 'item/1', runId: 'run/current', mode });
      assert.equal(client.getQueryState(origin)?.isInvalidated, true);
      assert.equal(client.getQueryState(other)?.isInvalidated, false);
      assert.deepEqual(client.getQueryData(origin), { messageQueue: queue });
    }
    assert.deepEqual(requests, [
      {
        path: '/api/sessions/session%2FA/message-queue/item%2F1/insert',
        method: 'POST',
        body: JSON.stringify({ runId: 'run/current', mode: 'live' }),
      },
      {
        path: '/api/sessions/session%2FA/message-queue/item%2F1/insert',
        method: 'POST',
        body: JSON.stringify({ runId: 'run/current', mode: 'priority' }),
      },
    ]);
    assert.deepEqual(store.getState().workspace.drafts['session/A'], originalDraft);
    assert.equal(store.getState().workspace.searchChargeLimits['session/A'], '25');
  } finally {
    store.dispatch(actions.dropDraft('session/A'));
    client.clear();
  }
});

test('insert conflict preserves structured errors, does not retry or change mode, and refreshes the originating session', async (t) => {
  const client = makeClient();
  const origin = sessionKeys.snapshot('origin');
  const other = sessionKeys.snapshot('other');
  client.setQueryData(origin, { messageQueue: queue });
  client.setQueryData(other, { messageQueue: queue });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    requests++;
    assert.deepEqual(JSON.parse(String(init?.body)), { runId: 'old-run', mode: 'live' });
    return Response.json(
      { error: { message: 'Run is no longer active', code: 'RUN_CHANGED' } },
      { status: 409 },
    );
  });
  try {
    const insert = new MutationObserver(client, insertQueuedMessageOptions(client, 'origin'));
    await assert.rejects(
      insert.mutate({ itemId: 'item/1', runId: 'old-run', mode: 'live' }),
      (failure: unknown) => {
        assert.ok(failure instanceof ApiError);
        assert.equal(failure.status, 409);
        assert.equal(failure.code, 'RUN_CHANGED');
        assert.match(failure.message, /Run is no longer active/);
        return true;
      },
    );
    assert.equal(requests, 1);
    assert.equal(client.getQueryState(origin)?.isInvalidated, true);
    assert.equal(client.getQueryState(other)?.isInvalidated, false);
    assert.deepEqual(client.getQueryData(origin), { messageQueue: queue });
  } finally {
    client.clear();
  }
});

test('insert rejects malformed acknowledgments and retains authoritative queue contents', async (t) => {
  const client = makeClient();
  const origin = sessionKeys.snapshot('origin');
  client.setQueryData(origin, { messageQueue: queue });
  t.mock.method(globalThis, 'fetch', async (input: unknown) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    return Response.json({ ok: false });
  });
  try {
    const insert = new MutationObserver(client, insertQueuedMessageOptions(client, 'origin'));
    await assert.rejects(insert.mutate({ itemId: 'item/1', runId: 'run', mode: 'priority' }));
    assert.equal(client.getQueryState(origin)?.isInvalidated, true);
    assert.deepEqual(client.getQueryData(origin), { messageQueue: queue });
  } finally {
    client.clear();
  }
});

test('insert pending state belongs only to its originating session while a later response settles', async (t) => {
  const client = makeClient();
  let respond: ((value: Response) => void) | undefined;
  const response = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  client.setQueryData(sessionKeys.snapshot('origin'), { messageQueue: queue });
  client.setQueryData(sessionKeys.snapshot('other'), { messageQueue: queue });
  const started = new Promise<void>((resolve) => {
    t.mock.method(globalThis, 'fetch', async (input: unknown) => {
      if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
      resolve();
      return response;
    });
  });
  try {
    const insert = new MutationObserver(client, insertQueuedMessageOptions(client, 'origin'));
    const result = insert.mutate({ itemId: 'item/1', runId: 'run', mode: 'live' });
    await started;
    assert.equal(client.isMutating({ mutationKey: sessionKeys.messageQueue('origin') }), 1);
    assert.equal(client.isMutating({ mutationKey: sessionKeys.messageQueue('other') }), 0);
    assert.equal(client.getQueryState(sessionKeys.snapshot('origin'))?.isInvalidated, false);
    assert.ok(respond);
    respond(Response.json({ ok: true }));
    await result;
    assert.equal(client.getQueryState(sessionKeys.snapshot('origin'))?.isInvalidated, true);
    assert.equal(client.getQueryState(sessionKeys.snapshot('other'))?.isInvalidated, false);
  } finally {
    respond?.(Response.json({ ok: true }));
    client.clear();
  }
});

test('queue shows server-selected insertion actions with an accessible priority stop description', () => {
  const insertQueue: SessionMessageQueue = {
    paused: false,
    items: [
      { id: 'live', text: 'First task', createdAt: 'now', error: null, insertion: 'live' },
      { id: 'priority', text: 'Second task', createdAt: 'now', error: null, insertion: 'priority' },
    ],
  };
  const markup = renderQueue(insertQueue, false, true, activeRun);
  assert.match(markup, /aria-label="立即插入消息 1"/);
  assert.match(markup, /aria-label="停止本轮并发送消息 2"/);
  const descriptionId = markup.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(descriptionId);
  assert.ok(markup.includes(`id="${descriptionId}"`));
  assert.match(markup, /优先执行会停止当前轮，再执行这条消息。/);
  assert.doesNotMatch(markup, /disabled=""/);
  assert.match(markup, /aria-label="查看消息 1：First task"/);
  assert.match(markup, /<details>/);
  assert.doesNotMatch(renderQueue(queue, false, true, activeRun), /aria-label="立即插入消息/);
});

test('queue only enables insert for an available active run in the same session', () => {
  const value: SessionMessageQueue = {
    paused: false,
    items: [{ id: 'live', text: 'Task', createdAt: 'now', error: null, insertion: 'live' }],
  };
  for (const run of [
    undefined,
    { ...activeRun, sessionId: 'other' },
    { ...activeRun, status: 'queued' as const },
    { ...activeRun, status: 'stopping' as const },
    { ...activeRun, status: 'completed' as const },
  ]) {
    assert.match(
      renderQueue(value, false, true, run),
      /disabled=""[^>]*aria-label="立即插入消息 1"/,
    );
  }
  assert.doesNotMatch(
    renderQueue(value, false, true, { ...activeRun, status: 'awaiting_permission' }),
    /disabled=""/,
  );
  assert.match(
    renderQueue(value, true, true, activeRun),
    /disabled=""[^>]*aria-label="立即插入消息 1"/,
  );
  const unavailable = renderQueue(value, false, false, activeRun);
  assert.match(unavailable, /disabled=""[^>]*aria-label="立即插入消息 1"/);
  assert.doesNotMatch(unavailable, /disabled=""[^>]*aria-label="撤回消息 1"/);
});

test('queue distinguishes waiting, sending and unknown delivery, retaining withdraw for unknown', () => {
  const value: SessionMessageQueue = {
    paused: false,
    items: [
      {
        id: 'waiting',
        text: 'Waiting task',
        createdAt: 'now',
        error: null,
        insertion: 'live',
        delivery: 'waiting',
      },
      {
        id: 'sending',
        text: 'Sending task',
        createdAt: 'now',
        error: null,
        insertion: 'live',
        delivery: 'sending',
      },
      {
        id: 'unknown',
        text: 'Unknown task',
        createdAt: 'now',
        error: 'Please verify delivery',
        insertion: 'live',
        delivery: 'unknown',
      },
    ],
  };
  const markup = renderQueue(value, false, true, activeRun);
  assert.match(markup, /等待发送/);
  assert.match(markup, /发送中…/);
  assert.match(markup, /结果待确认/);
  assert.match(markup, /Please verify delivery/);
  for (const index of [1, 2, 3]) {
    assert.ok(markup.includes(`disabled="" aria-label="立即插入消息 ${index}"`));
  }
  assert.match(markup, /disabled=""[^>]*aria-label="撤回消息 1"/);
  assert.match(markup, /disabled=""[^>]*aria-label="撤回消息 2"/);
  assert.doesNotMatch(markup, /disabled=""[^>]*aria-label="撤回消息 3"/);
});
