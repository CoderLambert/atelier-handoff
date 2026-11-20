/**
 * @file 验证会话消息队列的前端契约、恢复操作和展示。
 * @implementation 使用传输替身、独立 QueryClient 和静态渲染检查队列响应、URL 编码、空继续请求、会话精准刷新与暂停和错误可见性。
 * @updated 2026-11-20T23:09:03+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MutationObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionMessageQueue } from '@shared/types';
import { actions, store } from '@/app/store';
import { emptyDraft } from '@/app/drafts';
import { sessionKeys } from '@/use-query/sessions/keys';
import { sendSessionMessage } from '@/use-query/sessions/use-send-session-message';
import { resumeMessageQueueOptions } from '@/use-query/sessions/use-resume-message-queue';
import { withdrawQueuedMessageOptions } from '@/use-query/sessions/use-withdraw-queued-message';
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

function renderQueue(value: SessionMessageQueue, archived = false, available = true) {
  const client = makeClient();
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(MessageQueue, { sessionId: 'session', queue: value, archived, available }),
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
    await resume.mutate();
    assert.equal(client.getQueryState(origin)?.isInvalidated, true);
    assert.equal(client.getQueryState(other)?.isInvalidated, false);
    assert.deepEqual(requests, [
      {
        path: '/api/sessions/session%2FA/message-queue/item%2F1',
        method: 'DELETE',
        body: undefined,
      },
      { path: '/api/sessions/session%2FA/message-queue/resume', method: 'POST', body: '{}' },
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
    await assert.rejects(mutation.mutate());
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
