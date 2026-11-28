/**
 * @file 验证 v11 热路径索引、队列仓储和统一中断恢复。
 * @implementation 使用隔离 SQLite 核对 v10 升级与回滚、查询计划不全表扫描、恢复在故障时整体回滚且幂等，并对照原有队列语义。
 * @updated 2026-11-27T20:20:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { MessageQueue } from '../server/message-queue.js';
import { LATEST_SCHEMA_VERSION, Store } from '../server/store.js';
import type { Subagent } from '../shared/subagents.js';
import {
  emptyDraft,
  type Permission,
  type Project,
  type Run,
  type RunEvent,
  type Session,
  type ToolCall,
} from '../shared/types.js';
import { dropV11Schema } from './fixtures/downgrade-v11.js';

const at = '2026-11-27T12:00:00.000Z';
const config = {
  gateway: 'http://127.0.0.1:1',
  model: 'runtime-test',
  maxTurns: 16,
  timeoutMs: 300_000,
};

async function temporary(work: (directory: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-runtime-orm-'));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function project(directory: string): Project {
  return {
    id: randomUUID(),
    name: 'runtime fixture',
    path: join(directory, 'project'),
    branch: 'main',
    available: true,
    createdAt: at,
  };
}
function session(projectId: string, title: string): Session {
  return {
    id: randomUUID(),
    projectId,
    title,
    status: 'active',
    sdkSessionId: null,
    sdkConfigKey: 'old-config',
    createdAt: at,
    updatedAt: at,
    draft: emptyDraft(),
  };
}
function run(item: Session, id: string, status: Run['status'], extra: Partial<Run> = {}): Run {
  return {
    id,
    sessionId: item.id,
    projectId: item.projectId,
    prompt: id,
    mode: 'readonly',
    status,
    createdAt: at,
    startedAt: at,
    endedAt: status === 'running' || status === 'awaiting_permission' ? null : at,
    reason: null,
    error: null,
    retryOf: null,
    contextPaths: [],
    attachmentIds: [],
    plan: [],
    usage: null,
    config,
    ...extra,
  };
}
function tool(item: Run, id: string, status: ToolCall['status'], extra: Partial<ToolCall> = {}) {
  return {
    id,
    runId: item.id,
    sessionId: item.sessionId,
    name: 'Read',
    inputSummary: '{}',
    status,
    output: '',
    startedAt: at,
    endedAt: status === 'running' || status === 'awaiting_permission' ? null : at,
    ...extra,
  } satisfies ToolCall;
}
function permission(item: Run, id: string, toolCallId: string, status: Permission['status']) {
  return {
    id,
    runId: item.id,
    sessionId: item.sessionId,
    toolCallId,
    kind: 'edit',
    path: 'a.txt',
    command: null,
    before: null,
    after: 'x',
    diff: '+x',
    baseFingerprint: null,
    version: randomUUID(),
    status,
    createdAt: at,
    expiresAt: '2030-01-01T00:00:00.000Z',
    reason: 'fixture',
  } satisfies Permission;
}
function subagent(item: Run): Subagent {
  return {
    id: `${item.id}-task`,
    runId: item.id,
    sessionId: item.sessionId,
    kind: 'explore',
    title: 'Task',
    status: 'running',
    summary: null,
    startedAt: at,
    endedAt: null,
  };
}
function queueIntent(text: string, attachmentIds: string[] = []) {
  return {
    request: { text, idempotencyKey: randomUUID(), mode: 'readonly', attachmentIds },
    model: 'runtime-test',
    scope: 'scope',
  };
}
function plan(db: Store['db'], query: string, ...bindings: string[]) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${query}`)
    .all(...bindings)
    .map((row) => String(row.detail))
    .join('\n');
}
function rows(db: Store['db'] | DatabaseSync, query: string) {
  return (db.prepare(query).all() as Record<string, unknown>[]).map((row) => ({ ...row }));
}

function seedRuntime(store: Store, directory: string) {
  const owner = project(directory);
  store.put('projects', owner);
  const first = session(owner.id, 'first');
  const second = session(owner.id, 'second');
  store.put('sessions', first);
  store.put('sessions', second);
  const ordered = run(first, 'run-ordered', 'running', {
    transcript: {
      version: 1,
      notices: [{ kind: 'tool_preparing', toolCallId: 'p', toolName: 'Read', order: 4, at }],
      pendingDenials: [{ kind: 'tool_blocked', toolCallId: 'b', toolName: 'Bash', order: 3, at }],
    },
  });
  const waiting = run(second, 'run-waiting', 'awaiting_permission');
  const done = run(first, 'run-done', 'completed');
  for (const item of [ordered, waiting, done]) store.put('runs', item);
  const hooked = tool(ordered, 'tool-hooked', 'running', { transcriptHookOrder: 2 });
  const bashing = tool(waiting, 'tool-bash', 'running', {
    name: 'Bash',
    bashExecution: { phase: 'background', controllable: true, lastObservedAt: at },
  });
  const blocked = tool(waiting, 'tool-blocked', 'awaiting_permission');
  const staleBash = tool(done, 'tool-stale-bash', 'running', {
    name: 'Bash',
    bashExecution: { phase: 'background', controllable: true, lastObservedAt: at },
  });
  const staleRead = tool(done, 'tool-stale-read', 'running');
  const finished = tool(ordered, 'tool-finished', 'succeeded');
  for (const item of [hooked, bashing, blocked, staleBash, staleRead, finished])
    store.put('tools', item);
  const pending = permission(waiting, 'permission-pending', blocked.id, 'pending');
  const allowed = permission(done, 'permission-allowed', staleRead.id, 'allowed');
  store.put('permissions', pending);
  store.put('permissions', allowed);
  store.startSubagent(subagent(ordered));
  return { first, second, ordered, waiting, done };
}

test('v11 upgrades a v10 database in place, keeps rowids and rolls a failed migration back', async () =>
  temporary(async (directory) => {
    const data = join(directory, 'data');
    let expected: ReturnType<typeof rows>[] = [];
    const tables = ['runs', 'tools', 'permissions', 'artifacts'];
    const store = new Store(data);
    try {
      seedRuntime(store, directory);
      assert.equal(
        store.db.prepare('PRAGMA user_version').get()?.user_version,
        LATEST_SCHEMA_VERSION,
      );
      expected = tables.map((table) => rows(store.db, `SELECT rowid,id,data FROM ${table}`));
      store.db.exec(dropV11Schema);
      store.db.exec('PRAGMA user_version=10;');
    } finally {
      store.close();
    }
    const old = new DatabaseSync(join(data, 'atelier.sqlite'));
    try {
      old.exec('BEGIN IMMEDIATE');
      const sql = await readFile(
        new URL('../server/db/migrations/0011-runtime-hotpath-indexes.sql', import.meta.url),
        'utf8',
      );
      assert.throws(() => old.exec(sql + '\nSELECT missing_column FROM runs;'), /missing_column/u);
      old.exec('ROLLBACK');
      assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 10);
      assert.equal(
        rows(old, 'PRAGMA table_xinfo(runs)').some((column) => column.name === 'status'),
        false,
      );
    } finally {
      old.close();
    }
    for (let opening = 0; opening < 2; opening++) {
      const upgraded = new Store(data);
      try {
        assert.equal(
          upgraded.db.prepare('PRAGMA user_version').get()?.user_version,
          LATEST_SCHEMA_VERSION,
        );
        assert.deepEqual(
          tables.map((table) => rows(upgraded.db, `SELECT rowid,id,data FROM ${table}`)),
          expected,
        );
        assert.deepEqual(rows(upgraded.db, 'PRAGMA foreign_key_check'), []);
        assert.equal(rows(upgraded.db, 'PRAGMA quick_check')[0]?.quick_check, 'ok');
      } finally {
        upgraded.close();
      }
    }
  }));

test('hot-path queries search v11 indexes and never scan a record table', async () =>
  temporary((directory) => {
    const store = new Store(join(directory, 'data'));
    try {
      const marks = '?,?,?,?';
      const active = ['queued', 'running', 'awaiting_permission', 'stopping'];
      const queries: [string, string[], RegExp][] = [
        [
          `SELECT id,data FROM runs WHERE status IN (${marks}) ORDER BY rowid`,
          active,
          /runs USING INDEX runs_status/u,
        ],
        [
          `SELECT id,data FROM runs WHERE session_id=? AND status IN (${marks}) ORDER BY rowid LIMIT 1`,
          ['s', ...active],
          /runs USING INDEX runs_snapshot_session/u,
        ],
        [
          'SELECT id,data FROM tools WHERE run_id=? AND status IN (?,?) ORDER BY rowid',
          ['r', 'running', 'awaiting_permission'],
          /tools USING INDEX tools_run_status/u,
        ],
        [
          'SELECT id,data FROM tools WHERE run_id=? ORDER BY rowid',
          ['r'],
          /tools USING INDEX tools_run_status/u,
        ],
        [
          'SELECT id,data FROM tools WHERE status IN (?,?) ORDER BY rowid',
          ['running', 'awaiting_permission'],
          /tools USING INDEX tools_status/u,
        ],
        [
          'SELECT id,data FROM permissions WHERE run_id=? AND status=? ORDER BY rowid',
          ['r', 'pending'],
          /permissions USING INDEX permissions_run_status/u,
        ],
        [
          'SELECT id,data FROM permissions WHERE run_id=? ORDER BY rowid',
          ['r'],
          /permissions USING INDEX permissions_run_status/u,
        ],
        [
          'SELECT id,data FROM permissions WHERE status=? ORDER BY rowid',
          ['pending'],
          /permissions USING INDEX permissions_status/u,
        ],
        [
          'SELECT id,data FROM artifacts WHERE run_id=? ORDER BY rowid',
          ['r'],
          /artifacts USING INDEX artifacts_run/u,
        ],
      ];
      for (const [query, bindings, index] of queries) {
        const detail = plan(store.db, query, ...bindings);
        assert.match(detail, index, query);
        assert.doesNotMatch(detail, /\bSCAN\b/u, detail);
      }
    } finally {
      store.close();
    }
  }));

test('recovery interrupts runtime state in one transaction, including pending queue delivery', async (t) =>
  temporary((directory) => {
    const data = join(directory, 'data');
    let store = new Store(data);
    try {
      const fixture = seedRuntime(store, directory);
      const queue = new MessageQueue(store);
      const waiting = queue.enqueue(
        fixture.first.id,
        'k-waiting',
        'h1',
        { text: 'waiting' },
        queueIntent('waiting'),
      );
      const sending = queue.enqueue(
        fixture.first.id,
        'k-sending',
        'h2',
        { text: 'sending' },
        queueIntent('sending'),
      );
      queue.resume(fixture.first.id);
      const waitingItem = queue.pending(fixture.first.id, waiting.id);
      const sendingItem = queue.pending(fixture.first.id, sending.id);
      assert.ok(waitingItem && sendingItem);
      queue.beginLive(waitingItem, fixture.ordered.id);
      queue.beginLive(sendingItem, fixture.ordered.id);
      queue.dispatched(sendingItem, fixture.ordered.id);
      const queued = () =>
        rows(
          store.db,
          'SELECT id,paused,delivery,target_run_id,error FROM pending_messages ORDER BY seq',
        );
      const before = queued();
      const runsBefore = rows(store.db, 'SELECT rowid,id,data FROM runs');
      const toolsBefore = rows(store.db, 'SELECT rowid,id,data FROM tools');
      const permissionsBefore = rows(store.db, 'SELECT rowid,id,data FROM permissions');
      store.close();
      store = new Store(data);
      const original = store.event.bind(store);
      const notifications: RunEvent[] = [];
      store.events.on('event', (event: RunEvent) => notifications.push(event));
      const abort = new Error('abort recovery');
      const fault = t.mock.method(store, 'event', (...args: Parameters<Store['event']>) => {
        original(...args);
        throw abort;
      });
      assert.throws(
        () => store.recover(),
        (error) => error === abort,
      );
      fault.mock.restore();
      assert.deepEqual(queued(), before);
      assert.deepEqual(rows(store.db, 'SELECT rowid,id,data FROM runs'), runsBefore);
      assert.deepEqual(rows(store.db, 'SELECT rowid,id,data FROM tools'), toolsBefore);
      assert.deepEqual(rows(store.db, 'SELECT rowid,id,data FROM permissions'), permissionsBefore);
      assert.equal(notifications.length, 0);

      store.recover();
      assert.equal(store.get('runs', 'run-ordered').status, 'interrupted');
      assert.equal(store.get('runs', 'run-waiting').status, 'interrupted');
      assert.equal(store.get('runs', 'run-done').status, 'completed');
      assert.equal(store.get('runs', 'run-ordered').transcript?.pendingDenials, undefined);
      const hooked = store.get('tools', 'tool-hooked');
      assert.equal(hooked.status, 'canceled');
      assert.equal(hooked.transcriptOrder, 2);
      assert.equal(hooked.transcriptHookOrder, undefined);
      assert.equal(store.get('tools', 'tool-finished').status, 'succeeded');
      for (const id of ['tool-bash', 'tool-stale-bash']) {
        const bash = store.get('tools', id);
        assert.equal(bash.status, 'canceled');
        assert.equal(bash.bashExecution?.phase, 'unknown');
        assert.equal(bash.bashExecution?.controllable, false);
      }
      const blocked = store.get('tools', 'tool-blocked');
      assert.equal(blocked.status, 'canceled');
      assert.equal(blocked.output, '运行已中断，请检查此操作是否已产生结果。');
      assert.equal(store.get('tools', 'tool-stale-read').status, 'running');
      assert.equal(store.get('permissions', 'permission-pending').status, 'canceled');
      assert.equal(store.get('permissions', 'permission-allowed').status, 'allowed');
      assert.equal(store.get('sessions', fixture.first.id).sdkConfigKey, undefined);
      assert.equal(store.get('sessions', fixture.second.id).sdkConfigKey, undefined);
      assert.equal(
        store.sessionSnapshots.read(fixture.first.id).subagents[0]?.status,
        'interrupted',
      );
      assert.deepEqual(
        queued().map(({ paused, delivery, target_run_id, error }) => [
          paused,
          delivery,
          target_run_id,
          error,
        ]),
        [
          [1, null, null, null],
          [1, 'unknown', fixture.ordered.id, '运行中断，插入结果待确认。'],
        ],
      );
      const cursor = store.cursor();
      const snapshot = rows(store.db, 'SELECT rowid,id,data FROM tools');
      store.recover();
      assert.equal(store.cursor(), cursor);
      assert.deepEqual(rows(store.db, 'SELECT rowid,id,data FROM tools'), snapshot);
    } finally {
      store.close();
    }
  }));

test('queue repository keeps FIFO, priority, pause, receipt and withdrawal semantics', async () =>
  temporary((directory) => {
    const store = new Store(join(directory, 'data'));
    try {
      const owner = project(directory);
      store.put('projects', owner);
      const first = session(owner.id, 'first');
      const second = session(owner.id, 'second');
      store.put('sessions', first);
      store.put('sessions', second);
      const queue = new MessageQueue(store);
      const add = (item: Session, text: string, attachments: string[] = []) =>
        queue.enqueue(
          item.id,
          `${item.id}:${text}`,
          `hash-${text}`,
          { text },
          queueIntent(text, attachments),
        );
      const a = add(first, 'A');
      const b = add(first, 'B', ['attachment-1']);
      const c = add(first, 'C');
      const other = add(second, 'other');
      assert.deepEqual(
        queue.snapshot(first.id).items.map(({ text }) => text),
        ['A', 'B', 'C'],
      );
      assert.equal(queue.receipt(`${first.id}:A`, 'hash-A')?.id, a.id);
      assert.throws(() => queue.receipt(`${first.id}:A`, 'other'), {
        code: 'IDEMPOTENCY_CONFLICT',
      });
      assert.deepEqual(
        queue.heads().map((item) => item.id),
        [a.id, other.id],
      );

      const headA = queue.pending(first.id, a.id);
      const headB = queue.pending(first.id, b.id);
      assert.ok(headA && headB);
      assert.throws(() => queue.consume(headB), { code: 'QUEUE_CHANGED' });
      queue.block(headA, 'blocked');
      assert.deepEqual(
        queue.heads().map((item) => item.id),
        [other.id],
      );
      assert.equal(queue.snapshot(first.id).paused, true);
      assert.throws(() => queue.consume(headA), { code: 'QUEUE_CHANGED' });
      queue.resume(first.id);
      assert.equal(queue.snapshot(first.id).paused, false);

      const refreshedC = queue.pending(first.id, c.id);
      assert.ok(refreshedC);
      queue.prioritize(refreshedC);
      assert.deepEqual(
        queue.snapshot(first.id).items.map(({ text }) => text),
        ['C', 'A', 'B'],
      );
      assert.deepEqual(
        queue.heads().map((item) => item.id),
        [c.id, other.id],
      );
      queue.consume(refreshedC);
      assert.equal(queue.pending(first.id, c.id), undefined);

      const runId = randomUUID();
      store.put('runs', run(first, runId, 'running'));
      const live = queue.pending(first.id, a.id);
      assert.ok(live);
      queue.beginLive(live, runId);
      assert.throws(() => queue.beginLive(live, runId), { code: 'QUEUE_CHANGED' });
      assert.throws(() => queue.dispatched(live, 'another-run'), { code: 'QUEUE_CHANGED' });
      queue.releaseLive(live, runId);
      assert.equal(queue.snapshot(first.id).items[0]?.delivery, undefined);
      queue.beginLive(live, runId);
      queue.dispatched(live, runId);
      queue.releaseLive(live, runId);
      const uncertain = queue.snapshot(first.id).items[0];
      assert.equal(uncertain?.delivery, 'unknown');
      assert.equal(uncertain?.error, '未收到 SDK 回执，请核对会话结果。');
      queue.resume(first.id);
      assert.equal(queue.snapshot(first.id).items[0]?.delivery, 'unknown');

      const again = queue.pending(first.id, b.id);
      assert.ok(again);
      queue.beginLive(again, runId);
      queue.dispatched(again, runId);
      queue.confirmLive(again, runId);
      assert.equal(queue.pending(first.id, b.id), undefined);
      assert.deepEqual(store.runReceipts.find(again.request_key), {
        bodyHash: again.body_hash,
        runId,
      });
      queue.confirmLive(again, runId);
      assert.equal(store.runReceipts.find(again.request_key)?.runId, runId);

      assert.throws(() => queue.withdraw(first.id, b.id), { code: 'QUEUE_CHANGED' });
      queue.withdraw(first.id, a.id);
      assert.equal(queue.hasPending(first.id), false);
      assert.equal(queue.hasPending(second.id), true);
      assert.throws(() => queue.receipt(`${first.id}:A`, 'hash-A'), { code: 'QUEUE_WITHDRAWN' });
      assert.equal(queue.referencesAttachment(first.id, 'attachment-1'), false);
      const kept = add(first, 'D', ['attachment-2']);
      assert.equal(queue.referencesAttachment(first.id, 'attachment-2'), true);
      assert.equal(queue.referencesAttachment(first.id, 'attachment-9'), false);
      assert.equal(queue.referencesAttachment(second.id, 'attachment-2'), false);
      assert.ok(kept.id);
    } finally {
      store.close();
    }
  }));
