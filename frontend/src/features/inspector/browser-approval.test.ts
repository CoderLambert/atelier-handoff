/**
 * @file 验证内置浏览器授权展示、请求边界与审批复核门槛。
 * @implementation 用静态 React 渲染和本地传输替身检查授权披露、项目隔离、版本和审批失效，不启动窗口或模型。
 * @updated 2026-11-20T11:51:19+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DesktopBrowserState, DesktopBrowserAccessState } from '@shared/desktop-browser';
import type { Permission } from '@shared/types';
import { DesktopBrowser } from '@/app/desktop-browser';
import { browserKeys } from '@/use-query/browser/keys';
import { desktopBrowserAccessQuery } from '@/use-query/browser/use-desktop-browser-access';
import { updateDesktopBrowserAccess } from '@/use-query/browser/use-update-desktop-browser-access';
import { permissionKeys } from '@/use-query/permissions/keys';
import { permissionQuery } from '@/use-query/permissions/use-permission';
import { usePermissionReview } from './hooks/use-permission-review';
import { isOperationPermission, permissionOperation } from './shared';

const projectId = '11111111-1111-4111-8111-111111111111';
const revision = '22222222-2222-4222-8222-222222222222';
const tabId = '33333333-3333-4333-8333-333333333333';
const access: DesktopBrowserAccessState = { available: true, enabled: false, revision: null };
const permission: Permission = {
  id: 'permission-one',
  runId: 'run-one',
  sessionId: 'session-one',
  toolCallId: 'tool-one',
  kind: 'browser',
  path: null,
  command: 'browser_fill\n{"ref":"e12","value":"<script>exact text</script>"}',
  before: null,
  after: null,
  diff: '',
  baseFingerprint: null,
  version: 'review-one',
  status: 'pending',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  reason: '输入已确认的内容',
};

function renderBrowser(settings: DesktopBrowserAccessState | undefined, humanControl = true) {
  const client = new QueryClient();
  if (settings) client.setQueryData(browserKeys.desktopAccess(projectId), settings);
  const state: DesktopBrowserState = {
    projectId,
    tabs: [{ id: tabId, title: 'Local fixture', url: 'https://example.test/' }],
    activeTabId: tabId,
    agentTabId: tabId,
    transferring: false,
    url: 'https://example.test/',
    title: 'Local fixture',
    control: humanControl,
    busy: false,
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DesktopBrowser, { projectId, state }),
      ),
    );
  } finally {
    client.clear();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function renderReview(live: Permission, detail = live, preview = detail) {
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnMount: false } } });
  client.setQueryData(permissionKeys.detail(live), detail);
  client.setQueryData(permissionKeys.diff(live), preview);
  function Probe() {
    const review = usePermissionReview(live);
    return createElement('p', null, review.canDecide ? 'can-decide' : 'blocked');
  }
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    );
  } finally {
    client.clear();
  }
}

test('desktop browser opt-in is separate from human handoff and discloses page data use', () => {
  const html = renderBrowser(access);
  assert.equal((html.match(/aria-label="允许 Agent 使用内置浏览器"/g) ?? []).length, 1);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /启用 Agent 浏览器/);
  assert.match(html, /网页内容可能发送给模型/);
  assert.match(html, /点击、输入需要逐次审批/);
  assert.match(html, /交还仅结束人工接管；项目浏览器工具仍停用/);
  assert.doesNotMatch(html, /交还后 Agent 将继续当前标签/);
});

test('desktop browser distinguishes loading, enabled, unavailable and disabled authorization', () => {
  assert.match(renderBrowser(undefined), /正在读取 Agent 浏览器授权/);
  assert.match(renderBrowser({ ...access, enabled: true, revision }), /停用 Agent 浏览器/);
  assert.match(
    renderBrowser({ ...access, available: false, enabled: true, revision }),
    /本项目授权仍为启用，可停用/,
  );
  assert.match(
    renderBrowser({ ...access, available: false }),
    /aria-label="允许 Agent 使用内置浏览器"[^>]*disabled/,
  );
});

test('browser approvals use operation presentation and require matching, unexpired content', () => {
  assert.equal(permissionOperation(permission), '操作内置浏览器');
  assert.equal(isOperationPermission(permission), true);
  assert.equal(isOperationPermission({ ...permission, kind: 'edit' }), false);
  assert.match(renderReview(permission), /can-decide/);
  assert.match(
    renderReview(permission, permission, { ...permission, version: 'stale' }),
    /blocked/,
  );
  assert.match(renderReview(permission, { ...permission, version: 'stale' }), /blocked/);
  assert.match(renderReview(permission, permission, { ...permission, kind: 'edit' }), /blocked/);
  assert.match(renderReview({ ...permission, expiresAt: new Date(0).toISOString() }), /blocked/);
  assert.match(renderReview({ ...permission, status: 'canceled' }), /blocked/);
  assert.match(renderReview({ ...permission, command: null }), /blocked/);
});

test('desktop browser GET encodes project identity and validates the access response', async (t) => {
  const client = new QueryClient();
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json(access);
  });
  try {
    assert.deepEqual(await client.fetchQuery(desktopBrowserAccessQuery('project/one')), access);
    assert.deepEqual(requests, ['/api/projects/project%2Fone/desktop-browser']);
    assert.notDeepEqual(browserKeys.desktopAccess('one'), browserKeys.desktopAccess('two'));
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ...access, enabled: 'yes' }));
    await assert.rejects(client.fetchQuery(desktopBrowserAccessQuery('project/two')));
  } finally {
    client.clear();
  }
});

test('desktop browser PATCH sends the reviewed revision and surfaces conflicts without retrying', async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'local-test-token' });
    assert.equal(String(input), '/api/projects/project%2Fone/desktop-browser');
    assert.equal(init?.method, 'PATCH');
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? Response.json({ ...access, enabled: true, revision })
      : Response.json({ error: { message: '授权版本已变化', code: 'CONFLICT' } }, { status: 409 });
  });
  assert.deepEqual(
    await updateDesktopBrowserAccess({ projectId: 'project/one', enabled: true, revision: null }),
    { ...access, enabled: true, revision },
  );
  await assert.rejects(
    updateDesktopBrowserAccess({ projectId: 'project/one', enabled: false, revision }),
    /授权版本已变化/,
  );
  assert.deepEqual(bodies, [
    { enabled: true, revision: null },
    { enabled: false, revision },
  ]);
});

test('permission detail rejects responses for another approval', async (t) => {
  const client = new QueryClient();
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ permission: { ...permission, id: 'another-permission' } }),
  );
  try {
    await assert.rejects(client.fetchQuery(permissionQuery(permission)), /审批响应不匹配/);
  } finally {
    client.clear();
  }
});

test('desktop browser GET passes query cancellation to transport', async (t) => {
  const client = new QueryClient();
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal;
    started();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  try {
    const pending = client
      .fetchQuery(desktopBrowserAccessQuery(projectId))
      .catch((error: unknown) => error);
    await ready;
    await client.cancelQueries({ queryKey: browserKeys.desktopAccess(projectId), exact: true });
    await pending;
    assert.equal(requestSignal?.aborted, true);
  } finally {
    client.clear();
  }
});
