/**
 * @file 验证会话自动审批模式与任务发送行为。
 * @implementation 使用存储和发送替身检查直接运行或入队后的模式、Skill 与单次费用处理，以及串行保存、迟到编辑保护和会话隔离。
 * @updated 2026-11-20T23:09:03+08:00
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Draft, Run, SendSessionMessageResult } from '@shared/types';
import { actions, store } from '@/app/store';
import {
  deleteDraft,
  emptyDraft,
  readDraft,
  storage,
  submitDraft,
  updateDraft,
} from '@/app/drafts';
import {
  sendSessionMessage,
  type SessionMessageBody,
} from '@/use-query/sessions/use-send-session-message';
import { permissionSchema } from '@/use-query/permissions/use-permission';
import { parseSearchChargeLimit, runModeLabel } from './run-mode';

function result(sessionId: string): { run: Run } {
  return {
    run: {
      id: `run:${sessionId}`,
      sessionId,
      projectId: 'project',
      prompt: 'task',
      status: 'queued',
      mode: 'edit',
      approvalMode: 'automatic',
      maxSearchChargeFen: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      reason: null,
      error: null,
      retryOf: null,
      contextPaths: [],
      attachmentIds: [],
      plan: [],
      usage: null,
      config: { gateway: 'http://localhost', model: 'fixture', maxTurns: 1, timeoutMs: 1000 },
    },
  };
}
function memoryStorage(t: TestContext) {
  const data = new Map<string, string>();
  t.mock.method(storage, 'get', (key: string) => data.get(key) ?? null);
  t.mock.method(storage, 'set', (key: string, value: string) => {
    data.set(key, value);
  });
  t.mock.method(storage, 'remove', (key: string) => {
    data.delete(key);
  });
  return data;
}
function automatic(id: string, value = '0') {
  updateDraft(id, (draft) => ({ ...draft, mode: 'edit', approvalMode: 'automatic' }));
  store.dispatch(actions.setSearchChargeLimit({ id, value }));
}

// No model, runtime, window or real user storage is used by these send-lane regressions.
test('automatic session mode persists across sends and reload, while the paid limit is consumed once', async (t) => {
  const persisted = memoryStorage(t);
  const id = 'auto-retry';
  const draft: Draft = { ...emptyDraft(), text: 'make the change', contextPaths: ['src/file.ts'] };
  updateDraft(id, draft);
  automatic(id, '12');
  const sent: SessionMessageBody[] = [];
  let fail = true;
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    assert.equal(String(input), `/api/sessions/${id}/messages`);
    assert.equal(init?.method, 'POST');
    sent.push(JSON.parse(String(init?.body)) as SessionMessageBody);
    if (fail) {
      fail = false;
      throw new TypeError('response lost');
    }
    return Response.json(result(id));
  });
  try {
    await assert.rejects(submitDraft(id, draft, sendSessionMessage), /response lost/);
    assert.deepEqual(readDraft(id), { ...draft, mode: 'edit', approvalMode: 'automatic' });
    assert.equal(store.getState().workspace.searchChargeLimits[id], '12');
    assert.equal(store.getState().workspace.submitting[id], undefined);
    assert.match(persisted.get(`atelier-draft:${id}`) ?? '', /"approvalMode":"automatic"/);
    assert.doesNotMatch(persisted.get(`atelier-draft:${id}`) ?? '', /maxSearchChargeFen/);
    await submitDraft(id, draft, sendSessionMessage);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.equal(sent[0]?.mode, 'edit');
    assert.equal(sent[0]?.approvalMode, 'automatic');
    assert.equal(sent[0]?.maxSearchChargeFen, 12);
    assert.equal(readDraft(id).text, '');
    assert.equal(readDraft(id).approvalMode, 'automatic');
    assert.equal(store.getState().workspace.searchChargeLimits[id], undefined);
    store.dispatch(actions.dropDraft(id));
    assert.equal(readDraft(id).approvalMode, 'automatic');
    updateDraft(id, (current) => ({ ...current, text: 'next message' }));
    await submitDraft(id, draft, sendSessionMessage);
    assert.equal(sent[2]?.approvalMode, 'automatic');
    assert.equal(sent[2]?.maxSearchChargeFen, 0);
  } finally {
    await deleteDraft(id, async () => {});
  }
});

test('changing automatic cap changes the request key while unchanged draft is still cleared', async (t) => {
  memoryStorage(t);
  const id = 'auto-cap';
  const draft = { ...emptyDraft('edit'), text: 'do the task' };
  updateDraft(id, draft);
  automatic(id);
  const sent: SessionMessageBody[] = [];
  try {
    await assert.rejects(
      submitDraft(id, draft, async ({ body }) => {
        sent.push(body);
        throw new Error('offline');
      }),
      /offline/,
    );
    automatic(id, '100000');
    await submitDraft(id, draft, async ({ body }) => {
      sent.push(body);
      return result(id);
    });
    assert.notEqual(sent[0]?.idempotencyKey, sent[1]?.idempotencyKey);
    assert.equal(sent[1]?.maxSearchChargeFen, 100000);
    assert.equal(readDraft(id).text, '');
    assert.equal(readDraft(id).mode, 'edit');
  } finally {
    await deleteDraft(id, async () => {});
  }
});

test('late send completion preserves new draft edits and another session automatic selection', async (t) => {
  memoryStorage(t);
  const id = 'auto-late';
  const other = 'auto-other';
  const draft = { ...emptyDraft(), text: 'first' };
  updateDraft(id, draft);
  automatic(id, '2');
  automatic(other, '9');
  let finish: (value: { run: Run }) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Promise<{ run: Run }>((resolve) => {
    finish = resolve;
  });
  let sends = 0;
  const send = async () => {
    sends++;
    started();
    return response;
  };
  try {
    const pending = submitDraft(id, draft, send);
    await ready;
    await submitDraft(id, draft, send);
    assert.equal(sends, 1);
    assert.equal(store.getState().workspace.searchChargeLimits[id], '2');
    updateDraft(id, (previous) => ({ ...previous, text: 'next task' }));
    finish(result(id));
    await pending;
    assert.equal(readDraft(id).text, 'next task');
    assert.equal(store.getState().workspace.searchChargeLimits[id], undefined);
    assert.equal(readDraft(id).approvalMode, 'automatic');
    assert.equal(readDraft(other).approvalMode, 'automatic');
    assert.equal(store.getState().workspace.searchChargeLimits[other], '9');
  } finally {
    await deleteDraft(id, async () => {});
    await deleteDraft(other, async () => {});
  }
});

test('message waits for the pending draft save and stale completion cannot remove newer local draft', async (t) => {
  const persisted = memoryStorage(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const id = 'auto-save-lane';
  const draft = { ...emptyDraft(), text: 'first saved draft' };
  let finishSave: () => void = () => {};
  let patchStarted: () => void = () => {};
  const patchReady = new Promise<void>((resolve) => {
    patchStarted = resolve;
  });
  const patchResponse = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const order: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    assert.equal(init?.method, 'PATCH');
    assert.doesNotMatch(String(init?.body), /approvalMode|maxSearchChargeFen/);
    order.push('patch-start');
    patchStarted();
    await patchResponse;
    order.push('patch-finish');
    return Response.json({});
  });
  try {
    updateDraft(id, draft);
    t.mock.timers.tick(500);
    await patchReady;
    automatic(id);
    const pending = submitDraft(id, draft, async () => {
      order.push('message');
      return result(id);
    });
    updateDraft(id, (previous) => ({ ...previous, text: 'newer draft' }));
    await Promise.resolve();
    assert.deepEqual(order, ['patch-start']);
    finishSave();
    await pending;
    assert.deepEqual(order, ['patch-start', 'patch-finish', 'message']);
    assert.equal(readDraft(id).text, 'newer draft');
    assert.match(persisted.get(`atelier-draft:${id}`) ?? '', /newer draft/);
  } finally {
    finishSave();
    await deleteDraft(id, async () => {});
  }
});

test('readonly bound profile cannot send automatic options or edit mode', async (t) => {
  memoryStorage(t);
  const id = 'auto-readonly';
  const draft = { ...emptyDraft('edit'), text: 'read only' };
  updateDraft(id, draft);
  automatic(id, '42');
  try {
    await submitDraft(
      id,
      draft,
      async ({ body }) => {
        assert.equal(body.mode, 'readonly');
        assert.equal(body.approvalMode, undefined);
        assert.equal(body.maxSearchChargeFen, undefined);
        return result(id);
      },
      true,
    );
    assert.equal(readDraft(id).mode, 'readonly');
    assert.equal(store.getState().workspace.searchChargeLimits[id], undefined);
  } finally {
    await deleteDraft(id, async () => {});
  }
});

test('invalid cap rejects before a send, empty is optional, and run mode preserves history', async (t) => {
  memoryStorage(t);
  assert.equal(parseSearchChargeLimit(''), undefined);
  assert.equal(parseSearchChargeLimit('0'), 0);
  assert.equal(parseSearchChargeLimit('100000'), 100000);
  for (const invalid of ['-1', '1.5', '100001', '1e2', 'abc'])
    assert.throws(() => parseSearchChargeLimit(invalid), /整数/);
  const id = 'auto-invalid';
  const draft = { ...emptyDraft(), text: 'draft' };
  automatic(id, '100001');
  try {
    await assert.rejects(
      submitDraft(id, draft, async () => {
        assert.fail('invalid cap must not reach transport');
      }),
      /整数/,
    );
    assert.equal(store.getState().workspace.submitting[id], undefined);
    assert.equal(store.getState().workspace.searchChargeLimits[id], '100001');
    const { run } = result(id);
    assert.equal(runModeLabel(run), '全工具自动化');
    assert.equal(runModeLabel({ ...run, approvalMode: undefined }), '受控修改 · 逐次审批');
    assert.equal(runModeLabel({ ...run, approvalMode: undefined, mode: 'readonly' }), '只读');
  } finally {
    await deleteDraft(id, async () => {});
  }
});

for (const responseKind of ['run', 'queuedMessage'] as const) {
  test(`${responseKind} acceptance retains skills and sticky preferences but consumes the search allowance once`, async (t) => {
    memoryStorage(t);
    const id = `queue-retain-${responseKind}`;
    const draft: Draft = {
      ...emptyDraft('edit'),
      text: 'first task',
      approvalMode: 'automatic',
      model: 'selected-model',
      effort: 'xhigh',
      contextPaths: ['src/task.ts'],
      attachmentIds: ['attachment'],
      extensionSelections: [
        { id: 'command', version: 1 },
        { id: 'skill', version: 2 },
      ],
    };
    const extensions: NonNullable<Run['extensions']> = [
      { id: 'command', version: 1, kind: 'command', name: 'Command' },
      { id: 'skill', version: 2, kind: 'skill', name: 'Skill' },
      { id: 'mcp', version: 3, kind: 'mcp', name: 'MCP' },
    ];
    const accepted: SendSessionMessageResult =
      responseKind === 'run'
        ? { run: { ...result(id).run, extensions } }
        : {
            queuedMessage: {
              id: 'queued',
              text: draft.text,
              createdAt: 'now',
              error: null,
              extensions,
            },
          };
    const sent: SessionMessageBody[] = [];
    updateDraft(id, draft);
    store.dispatch(actions.setSearchChargeLimit({ id, value: '18' }));
    const send = async ({ body }: { body: SessionMessageBody }) => {
      sent.push(body);
      return accepted;
    };
    try {
      await submitDraft(id, draft, send);
      assert.deepEqual(readDraft(id), {
        ...emptyDraft('edit'),
        approvalMode: 'automatic',
        model: 'selected-model',
        effort: 'xhigh',
        extensionSelections: [{ id: 'skill', version: 2 }],
      });
      updateDraft(id, (previous) => ({ ...previous, text: 'next task' }));
      await submitDraft(id, draft, send);
      assert.equal(sent[0]?.maxSearchChargeFen, 18);
      assert.equal(sent[1]?.maxSearchChargeFen, 0);
      assert.notEqual(sent[0]?.idempotencyKey, sent[1]?.idempotencyKey);
      assert.equal(sent[1]?.model, 'selected-model');
      assert.equal(sent[1]?.effort, 'xhigh');
    } finally {
      await deleteDraft(id, async () => {});
    }
  });
}

test('queued response waits for SaveLane and preserves newer edits and another session allowance', async (t) => {
  const persisted = memoryStorage(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const id = 'queue-save-lane';
  const other = 'queue-other';
  const draft = { ...emptyDraft('edit'), text: 'queued draft', approvalMode: 'automatic' as const };
  let finishSave: () => void = () => {};
  let saveStarted: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  const saving = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    if (String(input) === '/api/bootstrap') return Response.json({ csrfToken: 'fixture' });
    assert.equal(init?.method, 'PATCH');
    saveStarted();
    await saving;
    return Response.json({});
  });
  updateDraft(id, draft);
  t.mock.timers.tick(500);
  await ready;
  automatic(other, '7');
  store.dispatch(actions.setSearchChargeLimit({ id, value: '8' }));
  let sent = 0;
  try {
    const pending = submitDraft(id, draft, async () => {
      sent++;
      return { queuedMessage: { id: 'queued', text: draft.text, createdAt: 'now', error: null } };
    });
    await Promise.resolve();
    assert.equal(sent, 0);
    updateDraft(id, (previous) => ({ ...previous, text: 'new draft while sending' }));
    finishSave();
    await pending;
    assert.equal(sent, 1);
    assert.equal(readDraft(id).text, 'new draft while sending');
    assert.match(persisted.get(`atelier-draft:${id}`) ?? '', /new draft while sending/);
    assert.equal(readDraft(id).approvalMode, 'automatic');
    assert.equal(store.getState().workspace.searchChargeLimits[id], undefined);
    assert.equal(store.getState().workspace.searchChargeLimits[other], '7');
  } finally {
    finishSave();
    await deleteDraft(id, async () => {});
    await deleteDraft(other, async () => {});
  }
});

test('permission detail parser retains automatic decision provenance and accepts old manual records', () => {
  const record = {
    id: 'permission',
    runId: 'run',
    sessionId: 'session',
    toolCallId: 'tool',
    kind: 'command',
    path: null,
    command: 'pwd',
    before: null,
    after: null,
    diff: '',
    baseFingerprint: null,
    version: 'v1',
    status: 'allowed',
    createdAt: 'now',
    expiresAt: 'later',
    reason: 'test',
  };
  assert.equal(permissionSchema.parse(record).decisionSource, undefined);
  assert.equal(
    permissionSchema.parse({ ...record, decisionSource: 'automatic' }).decisionSource,
    'automatic',
  );
});
