/**
 * @file 验证 MCP 编辑和聊天选用的共享约束。
 * @implementation 使用 QueryClient、模拟 HTTP 响应与候选模型验证 scope、收回共享和缓存刷新。
 * @updated 2026-11-27T00:00:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Draft } from '@shared/types';
import {
  extensionKeys,
  extensionMutationOptions,
  extensionPickerKeys,
  extensionsQuery,
  invalidateExtensionPickers,
  pickerCatalogItems,
  type McpExtension,
} from './api';
import { mcpChatOptions } from './mcp-sharing';
import { choices, chooseExtension, selectionReason, triggerAt } from './picker-model';

const shared = {
  id: 'shared-docs',
  projectId: 'owner',
  kind: 'mcp',
  name: 'docs',
  source: 'manual',
  description: '',
  enabled: true,
  version: 1,
  status: 'connected',
  transport: { type: 'stdio', command: 'fixture', args: [], envNames: [] },
  tools: [{ name: 'read', description: 'Read docs' }],
  allowedTools: [{ name: 'read', access: 'read' }],
  ...mcpChatOptions('stdio', true, false),
} satisfies McpExtension & { shareAcrossProjects: boolean };

const local = { ...shared, id: 'local-docs', projectId: 'consumer', shareAcrossProjects: false };

function catalog(client: QueryClient, projectId: string) {
  const state = client.getQueryState<McpExtension[]>(extensionPickerKeys.list(projectId));
  return pickerCatalogItems(projectId, state?.data, state);
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

test('MCP JSON saves explicitly clear sharing for HTTP or opt-out and disable auto-use when shared', () => {
  assert.deepEqual(mcpChatOptions('stdio', true, true), {
    shareAcrossProjects: true,
    autoUseInChat: false,
  });
  for (const options of [
    mcpChatOptions('http', true, true),
    mcpChatOptions('stdio', false, true),
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(options)), {
      shareAcrossProjects: false,
      autoUseInChat: true,
    });
  }
});

test('only the picker fetches shared MCPs and selects them by ID and version with #', async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    requests.push(path);
    return Response.json({ items: path.endsWith('?scope=picker') ? [local, shared] : [local] });
  });
  const client = queryClient();
  const projectId = 'consumer';
  assert.deepEqual(await client.fetchQuery(extensionsQuery(projectId)), [local]);
  await client.fetchQuery(extensionsQuery(projectId, 'picker'));
  assert.deepEqual(requests, [
    '/api/projects/consumer/extensions',
    '/api/projects/consumer/extensions?scope=picker',
  ]);
  assert.deepEqual(client.getQueryData(extensionKeys.list(projectId)), [local]);
  assert.deepEqual(catalog(client, projectId), [local, shared]);
  const draft: Draft = { text: '#docs/read', mode: 'edit', contextPaths: [], attachmentIds: [] };
  const trigger = triggerAt(draft.text, draft.text.length, draft.text.length)!;
  const row = choices(catalog(client, projectId), trigger, draft.text, draft.mode).find(
    ({ item }) => item.id === shared.id,
  );
  assert.ok(row);
  const selected = chooseExtension(draft, trigger, row).draft.extensionSelections?.[0];
  assert.deepEqual(selected, { id: shared.id, version: shared.version, tools: ['read'] });
  assert.equal(selectionReason(shared, selected, draft.mode, true), '');
  assert.deepEqual(choices(catalog(client, projectId), triggerAt('/', 1, 1)!, '/', 'edit'), []);
});

test('MCP mutations refresh the active foreign picker and invalidate all inactive picker caches', async (t) => {
  let visible = true;
  let failRefresh = false;
  t.mock.method(globalThis, 'fetch', async (path: string, options?: RequestInit) => {
    if (path === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    if (options?.method === 'PATCH' && path === '/api/projects/owner/extensions/shared-docs') {
      assert.deepEqual(JSON.parse(String(options.body)), {
        version: 1,
        shareAcrossProjects: false,
      });
      visible = false;
      return Response.json({ item: { ...shared, shareAcrossProjects: false, version: 2 } });
    }
    assert.ok(path.endsWith('/extensions?scope=picker'));
    if (failRefresh) return Response.json({}, { status: 500 });
    return Response.json({ items: visible ? [local, shared] : [local] });
  });
  const client = queryClient();
  client.setQueryData(extensionKeys.list('consumer'), [local]);
  const active = new QueryObserver(client, extensionsQuery('consumer', 'picker'));
  const unobserve = active.subscribe(() => {});
  t.after(unobserve);
  await client.fetchQuery(extensionsQuery('consumer', 'picker'));
  await client.fetchQuery(extensionsQuery('other', 'picker'));
  await client.fetchQuery(extensionsQuery('owner', 'picker'));
  assert.deepEqual(catalog(client, 'consumer'), [local, shared]);

  const revoke = new MutationObserver(client, extensionMutationOptions(client, 'owner'));
  await revoke.mutate({
    method: 'PATCH',
    suffix: shared.id,
    body: { version: 1, shareAcrossProjects: false },
  });
  assert.deepEqual(catalog(client, 'consumer'), [local]);
  for (const projectId of ['other', 'owner']) {
    assert.equal(client.getQueryState(extensionPickerKeys.list(projectId))?.isInvalidated, true);
  }
  assert.deepEqual(catalog(client, 'other'), []);
  assert.equal(client.getQueryState(extensionKeys.list('consumer'))?.isInvalidated, false);
  assert.deepEqual(await client.fetchQuery(extensionsQuery('other', 'picker')), [local]);

  client.setQueryData(extensionPickerKeys.list('consumer'), [local, shared]);
  failRefresh = true;
  await invalidateExtensionPickers(client);
  assert.deepEqual(active.getCurrentResult().data, [local, shared]);
  assert.deepEqual(
    catalog(client, 'consumer'),
    [local],
    'do not reuse revoked foreign data after an error',
  );
  const selected = { id: shared.id, version: shared.version, tools: ['read'] };
  assert.ok(
    selectionReason(
      catalog(client, 'consumer').find(({ id }) => id === shared.id),
      selected,
      'edit',
      true,
    ),
  );
});

test('picker invalidation replaces a pre-change first load even without cached data', async (t) => {
  let requests = 0;
  let releaseFirst!: (response: Response) => void;
  const firstResponse = new Promise<Response>((resolve) => {
    releaseFirst = resolve;
  });
  let oldSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', async (_path: string, options?: RequestInit) => {
    if (++requests === 1) {
      oldSignal = options?.signal;
      return firstResponse;
    }
    return Response.json({ items: [local] });
  });
  const client = queryClient();
  const active = new QueryObserver(client, extensionsQuery('consumer', 'picker'));
  const unobserve = active.subscribe(() => {});
  t.after(unobserve);
  assert.equal(requests, 1);

  await invalidateExtensionPickers(client);
  assert.equal(oldSignal?.aborted, true);
  assert.equal(requests, 2);
  releaseFirst(Response.json({ items: [local, shared] }));
  assert.deepEqual(catalog(client, 'consumer'), [local]);
});
