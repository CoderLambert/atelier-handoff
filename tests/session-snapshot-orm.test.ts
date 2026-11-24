/**
 * @file 验证会话快照的 ORM 查询、旧库升级和事务一致性。
 * @implementation 使用隔离 SQLite、真实 HTTP 与独立 v5 查询基线核对内容、插入顺序、查询计划和同连接回滚。
 * @updated 2026-11-21T00:58:16+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { MessageQueue } from '../server/message-queue.js';
import { Store } from '../server/store.js';
import type { Subagent } from '../shared/subagents.js';
import {
  AppError,
  emptyDraft,
  type AgentRevision,
  type AgentSessionInfo,
  type AppConfig,
  type Project,
  type RunEvent,
  type Session,
  type SessionMessageQueue,
  type Table,
  type Tables,
} from '../shared/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const at = '2026-11-20T12:00:00.000Z';
const earlier = '2026-11-19T12:00:00.000Z';
const scopedTables = [
  'runs',
  'messages',
  'tools',
  'permissions',
  'artifacts',
  'attachments',
] as const;
const jsonTables = [
  'projects',
  'sessions',
  ...scopedTables,
  'extensions',
  'agents',
  'agentRevisions',
] as const;
type ScopedTable = (typeof scopedTables)[number];
type Database = DatabaseSync | Store['db'];
type Bindings = Parameters<ReturnType<Store['db']['prepare']>['all']>;
type LegacySnapshot = {
  session: Session;
  project: Project;
  events: RunEvent[];
  cursor: number;
  subagents: Subagent[];
} & { [K in ScopedTable]: Tables[K][] };
const config: AppConfig = {
  gateway: 'http://127.0.0.1:1',
  managedGateway: false,
  model: 'snapshot-test',
  limitExecution: false,
  maxTurns: 16,
  timeoutMs: 300_000,
};

async function temporary(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-session-snapshot-'));
  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rows(db: Database, query: string, ...bindings: string[]): Record<string, unknown>[] {
  return (db.prepare(query).all(...bindings) as Record<string, unknown>[]).map((row) => ({
    ...row,
  }));
}

function jsonRows<K extends Table>(db: Database, table: K): Tables[K][] {
  return rows(db, `SELECT data FROM ${table} ORDER BY rowid`).map(
    (row) => JSON.parse(String(row.data)) as Tables[K],
  );
}

// Preserve the pre-v6 list/filter behavior independently of the new repository and history query.
function legacySnapshot(db: Database, sessionId: string): LegacySnapshot {
  const session = jsonRows(db, 'sessions').find((item) => item.id === sessionId);
  assert.ok(session);
  const project = jsonRows(db, 'projects').find((item) => item.id === session.projectId);
  assert.ok(project);
  const scoped = <K extends ScopedTable>(table: K) =>
    jsonRows(db, table).filter((item) => item.sessionId === sessionId);
  const events = rows(db, 'SELECT * FROM events ORDER BY id');
  return {
    session,
    project,
    subagents: [],
    runs: scoped('runs'),
    messages: scoped('messages'),
    tools: scoped('tools'),
    permissions: scoped('permissions'),
    artifacts: scoped('artifacts'),
    attachments: scoped('attachments').filter((item) => !item.removed || item.status === 'used'),
    events: events
      .filter((item) => item.session_id === sessionId)
      .slice(-500)
      .map((item) => ({
        id: Number(item.id),
        runId: String(item.run_id),
        sessionId: String(item.session_id),
        seq: Number(item.seq),
        type: String(item.type),
        at: String(item.at),
        payload: JSON.parse(String(item.payload)) as Record<string, unknown>,
      })),
    cursor: Number(events.at(-1)?.id ?? 0),
  };
}

function records(session: Session, position: number): { [K in ScopedTable]: Tables[K] } {
  // IDs and timestamps deliberately disagree with insertion order, including timestamp ties.
  const id = (kind: string) => `${session.id}-${kind}-${9 - position}`;
  const createdAt = position === 2 ? earlier : at;
  const runId = id('run');
  return {
    runs: {
      id: runId,
      sessionId: session.id,
      projectId: session.projectId,
      prompt: `turn ${position}`,
      status: 'completed',
      mode: 'readonly',
      createdAt,
      startedAt: createdAt,
      endedAt: createdAt,
      reason: null,
      error: null,
      retryOf: null,
      contextPaths: ['note.txt'],
      attachmentIds: [],
      plan: [{ content: 'Retain the plan', status: 'completed' }],
      usage: null,
      config,
    },
    messages: {
      id: id('message'),
      sessionId: session.id,
      runId,
      role: position % 2 ? 'assistant' : 'user',
      text: `message ${position} for ${session.id}`,
      createdAt,
    },
    tools: {
      id: id('tool'),
      sessionId: session.id,
      runId,
      name: 'read_file',
      inputSummary: 'note.txt',
      status: 'succeeded',
      output: `output ${position}`,
      outputLength: 100_000,
      outputTruncated: true,
      startedAt: createdAt,
      endedAt: createdAt,
      permissionId: id('permission'),
    },
    permissions: {
      id: id('permission'),
      sessionId: session.id,
      runId,
      toolCallId: id('tool'),
      kind: 'edit',
      path: 'note.txt',
      command: null,
      before: 'before',
      after: 'after',
      diff: '+after',
      baseFingerprint: 'fixture-fingerprint',
      version: randomUUID(),
      status: 'allowed',
      createdAt,
      expiresAt: '2026-11-22T12:00:00.000Z',
      reason: 'Retain approval details',
      resolutionReason: 'Approved for this operation',
    },
    artifacts: {
      id: id('artifact'),
      sessionId: session.id,
      projectId: session.projectId,
      runId,
      name: `result-${position}.md`,
      mime: 'text/markdown',
      size: position + 10,
      fingerprint: 'a'.repeat(64),
      availability: position === 2 ? 'unavailable' : 'available',
      createdAt,
    },
    attachments: {
      id: id('attachment'),
      sessionId: session.id,
      name: `source-${position}.txt`,
      mime: 'text/plain',
      size: position + 20,
      status: position === 1 ? 'used' : 'ready',
      createdAt,
      ...(position === 1 || position === 2 ? { removed: true } : {}),
      ...(position === 3 ? { removed: false } : {}),
    },
  };
}

function seed(write: <K extends Table>(table: K, value: Tables[K]) => unknown, directory: string) {
  const project: Project = {
    id: randomUUID(),
    name: 'snapshot fixture',
    path: join(directory, 'project'),
    branch: 'fixture',
    available: true,
    createdAt: at,
  };
  const otherProject = { ...project, id: randomUUID(), path: join(directory, 'other-project') };
  write('projects', project);
  write('projects', otherProject);
  const session = (projectId: string, title: string): Session => ({
    id: randomUUID(),
    projectId,
    title,
    status: 'active',
    sdkSessionId: null,
    createdAt: at,
    updatedAt: at,
    draft: { ...emptyDraft(), text: `draft for ${title}` },
  });
  const first = session(project.id, 'first');
  const second = session(project.id, 'second');
  const outside = session(otherProject.id, 'other project');
  const empty = session(project.id, 'empty');
  for (const item of [first, second, outside, empty]) write('sessions', item);
  for (let position = 0; position < 4; position++) {
    for (const item of [first, second, outside]) {
      const batch = records(item, position);
      for (const table of scopedTables) write(table, batch[table]);
    }
  }
  return { project, first, second, outside, empty };
}

async function serve(directory: string) {
  const app = await createApp({
    root,
    data: directory,
    runnerFactory: () => ({
      start() {
        assert.fail('Snapshot reads must not start the runner');
      },
      insert() {
        assert.fail('Snapshot reads must not dispatch queued input');
      },
      stop() {},
      async shutdown() {},
    }),
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    app,
    async get(id: string, expected = 200): Promise<unknown> {
      // GET needs no bootstrap/token; bootstrap would probe an unrelated gateway and git branch.
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${id}`);
      const body: unknown = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      return body;
    },
  };
}

test('HTTP snapshots retain v5 contents, rowid order, attachment visibility, queue and agent metadata', async () =>
  temporary(async (directory) => {
    const { app, get } = await serve(join(directory, 'data'));
    try {
      const { first, second, outside, empty } = seed(app.store.put.bind(app.store), directory);
      app.store.setConfig(config);
      const oldRevision: AgentRevision = {
        id: randomUUID(),
        agentId: randomUUID(),
        projectId: first.projectId,
        version: 1,
        config: {
          name: 'Frozen agent',
          description: 'Historical binding',
          instructions: 'Read project notes',
          starters: ['Read notes'],
          mode: 'readonly',
          capabilities: ['read', 'context'],
          skills: [],
          mcp: [],
        },
        dependencies: null,
        createdAt: earlier,
      };
      const revision = {
        ...oldRevision,
        id: randomUUID(),
        version: 2,
        config: { ...oldRevision.config, name: 'Current agent' },
        dependencies: { skills: [], mcp: [] },
        createdAt: at,
      };
      app.store.put('agentRevisions', oldRevision);
      app.store.put('agentRevisions', revision);
      app.store.put('agents', {
        id: revision.agentId,
        projectId: revision.projectId,
        revisionId: revision.id,
        archived: false,
        createdAt: earlier,
        updatedAt: at,
      });
      for (const item of [first, empty])
        app.store.update('sessions', item.id, { agentRevisionId: oldRevision.id });
      const binding: AgentSessionInfo = {
        id: oldRevision.agentId,
        revisionId: oldRevision.id,
        name: oldRevision.config.name,
        version: oldRevision.version,
        capabilities: oldRevision.config.capabilities,
        mode: oldRevision.config.mode,
        starters: oldRevision.config.starters,
        skills: [],
        mcp: [],
        issues: ['智能体依赖的历史快照无效，请重新发布配置。'],
      };
      const active = records(first, 0).runs;
      app.store.update('runs', active.id, { status: 'running', inputScope: 'snapshot-scope' });
      const queue = new MessageQueue(app.store);
      const enqueue = (item: Session, text: string) =>
        queue.enqueue(
          item.id,
          randomUUID(),
          randomUUID(),
          { text },
          {
            request: { text, idempotencyKey: randomUUID(), mode: 'readonly' },
            model: config.model,
            scope: 'snapshot-scope',
          },
        );
      const ordinary = enqueue(first, 'ordinary');
      const foreign = enqueue(second, 'other session');
      const withdrawn = enqueue(first, 'withdrawn');
      queue.withdraw(first.id, withdrawn.id);
      const priority = enqueue(first, '/priority');
      const pending = queue.pending(first.id, priority.id);
      assert.ok(pending);
      queue.prioritize(pending);
      queue.block(pending, 'Keep this error');
      const firstQueue: SessionMessageQueue = {
        items: [
          { ...priority, error: 'Keep this error', insertion: 'priority' },
          { ...ordinary, insertion: 'live' },
        ],
        paused: true,
      };
      for (let index = 0; index < 507; index++) {
        app.store.event(active.id, first.id, 'snapshot.fixture', { index });
        if (index % 3 === 0) app.store.event('other-run', second.id, 'snapshot.fixture', { index });
      }
      app.store.event('outside-run', outside.id, 'snapshot.fixture', { final: true });
      app.store.db
        .prepare('UPDATE events SET at=CASE WHEN id%2=0 THEN ? ELSE ? END')
        .run(earlier, at);
      const baseline = legacySnapshot(app.store.db, first.id);
      assert.equal(baseline.events.length, 500);
      assert.equal(baseline.events[0]?.payload.index, 7);
      assert.equal(baseline.events.at(-1)?.payload.index, 506);
      assert.ok(baseline.cursor > (baseline.events.at(-1)?.id ?? 0));
      assert.deepEqual(
        baseline.attachments.map((item) => item.name),
        ['source-0.txt', 'source-1.txt', 'source-3.txt'],
      );
      for (const item of [first, second, outside, empty]) {
        const expected = {
          ...legacySnapshot(app.store.db, item.id),
          ...([first.id, empty.id].includes(item.id)
            ? { agent: { ...binding, canUpgrade: item.id === empty.id } }
            : {}),
          messageQueue:
            item.id === first.id
              ? firstQueue
              : { items: item.id === second.id ? [foreign] : [], paused: false },
        };
        assert.deepEqual(await get(item.id), expected, item.title);
      }
      const missing = await get(randomUUID(), 404);
      assert.ok(missing && typeof missing === 'object' && 'error' in missing);
      assert.ok(missing.error && typeof missing.error === 'object' && 'code' in missing.error);
      assert.equal(missing.error.code, 'NOT_FOUND');
      const orphan = app.store.put('sessions', {
        ...empty,
        id: randomUUID(),
        projectId: randomUUID(),
      });
      await get(orphan.id, 404);
    } finally {
      await app.close();
    }
  }));

// This is the actual pre-v6 schema, built without Store or the current migration runner.
function createV5(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  for (const table of jsonTables)
    db.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;`,
    );
  db.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id,seq)) STRICT;
    CREATE INDEX events_session ON events(session_id,id);
    CREATE TABLE idempotency (key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, run_id TEXT NOT NULL) STRICT;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE UNIQUE INDEX project_path ON projects(json_extract(data,'$.path'));
    CREATE INDEX sessions_project ON sessions(json_extract(data,'$.projectId'));
    CREATE INDEX runs_session ON runs(json_extract(data,'$.sessionId'));
    CREATE INDEX messages_session ON messages(json_extract(data,'$.sessionId'));
    CREATE INDEX extensions_project ON extensions(json_extract(data,'$.projectId'));
    CREATE INDEX agents_project ON agents(json_extract(data,'$.projectId'));
    CREATE INDEX agent_revisions_project ON agentRevisions(json_extract(data,'$.projectId'));
    CREATE UNIQUE INDEX agent_revision_version ON agentRevisions(json_extract(data,'$.agentId'),json_extract(data,'$.version'));
    CREATE TRIGGER agent_revisions_immutable_update BEFORE UPDATE ON agentRevisions BEGIN
      SELECT RAISE(ABORT, 'Agent revisions are immutable.');
    END;
    CREATE TRIGGER agent_revisions_immutable_delete BEFORE DELETE ON agentRevisions BEGIN
      SELECT RAISE(ABORT, 'Agent revisions are immutable.');
    END;
    CREATE TABLE pending_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      request_key TEXT NOT NULL UNIQUE,
      body_hash TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)),
      withdrawn INTEGER NOT NULL DEFAULT 0,
      paused INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      delivery TEXT CHECK(delivery IN ('waiting','sending','unknown')),
      target_run_id TEXT
    ) STRICT;
    CREATE INDEX pending_messages_session ON pending_messages(session_id,seq) WHERE withdrawn=0;
    PRAGMA user_version=5;
  `);
}

test('a genuine v5 database migrates without changing JSON, rowids or snapshots and reopens safely', async () =>
  temporary(async (directory) => {
    const data = join(directory, 'data');
    await mkdir(data);
    const db = new DatabaseSync(join(data, 'atelier.sqlite'));
    const auxiliaryTables = ['events', 'idempotency', 'settings', 'pending_messages'] as const;
    let expected: LegacySnapshot[];
    let original: Record<string, Record<string, unknown>[]>;
    let auxiliary: Record<string, Record<string, unknown>[]>;
    try {
      createV5(db);
      const fixture = seed((table, item) => {
        db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run(item.id, JSON.stringify(item));
      }, directory);
      db.prepare(
        'INSERT INTO events(run_id,session_id,seq,type,at,payload) VALUES(?,?,?,?,?,?)',
      ).run('v5-run', fixture.first.id, 1, 'message.delta', at, '{"text":"v5 history"}');
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(
        'config',
        JSON.stringify(config),
      );
      db.prepare('INSERT INTO idempotency(key,body_hash,run_id) VALUES(?,?,?)').run(
        'old-receipt',
        'old-hash',
        'v5-run',
      );
      db.prepare(
        `
        INSERT INTO pending_messages(id,session_id,request_key,body_hash,data,paused,error,priority,delivery,target_run_id)
        VALUES(?,?,?,?,?,1,'legacy error',7,'unknown','v5-run')
      `,
      ).run(
        randomUUID(),
        fixture.first.id,
        'old-queued-key',
        'queued-hash',
        JSON.stringify({ text: 'v5 queued', createdAt: at, intent: {} }),
      );
      auxiliary = Object.fromEntries(
        auxiliaryTables.map((table) => [table, rows(db, `SELECT * FROM ${table} ORDER BY rowid`)]),
      );
      expected = [fixture.first, fixture.second, fixture.outside, fixture.empty].map((item) =>
        legacySnapshot(db, item.id),
      );
      original = Object.fromEntries(
        jsonTables.map((table) => [
          table,
          rows(db, `SELECT rowid,id,data FROM ${table} ORDER BY rowid`),
        ]),
      );
      for (const table of scopedTables)
        assert.deepEqual(
          rows(db, `PRAGMA table_xinfo(${table})`).map((column) => column.name),
          ['id', 'data'],
        );
      assert.equal(rows(db, 'PRAGMA user_version')[0]?.user_version, 5);
    } finally {
      db.close();
    }
    for (let opening = 0; opening < 2; opening++) {
      const store = new Store(data);
      try {
        assert.equal(rows(store.db, 'PRAGMA user_version')[0]?.user_version, 10);
        for (const table of jsonTables)
          assert.deepEqual(
            rows(store.db, `SELECT rowid,id,data FROM ${table} ORDER BY rowid`),
            original[table],
          );
        for (const table of auxiliaryTables)
          assert.deepEqual(
            rows(store.db, `SELECT * FROM ${table} ORDER BY rowid`),
            auxiliary[table],
          );
        for (const table of scopedTables) {
          const column = rows(store.db, `PRAGMA table_xinfo(${table})`).find(
            (item) => item.name === 'session_id',
          );
          assert.equal(column?.hidden, 2, `${table}.session_id is virtual`);
          const ids = rows(store.db, `SELECT session_id FROM ${table} ORDER BY rowid`);
          assert.deepEqual(
            ids.map((item) => item.session_id),
            jsonRows(store.db, table).map((item) => item.sessionId),
          );
          assert.ok(
            rows(store.db, `PRAGMA index_list(${table})`).some(
              (item) => item.name === `${table}_snapshot_session`,
            ),
          );
        }
        for (const snapshot of expected)
          assert.deepEqual(store.sessionSnapshots.read(snapshot.session.id), snapshot);
        assert.equal(rows(store.db, 'PRAGMA quick_check')[0]?.quick_check, 'ok');
        assert.deepEqual(rows(store.db, 'PRAGMA foreign_key_check'), []);
      } finally {
        store.close();
      }
    }
  }));

test('snapshot repositories see Store writes on the same connection and roll back all collections', async () =>
  temporary(async (directory) => {
    const data = join(directory, 'data');
    let store = new Store(data);
    try {
      const { first, second } = seed(store.put.bind(store), directory);
      const before = store.sessionSnapshots.read(first.id);
      const abort = new Error('abort snapshot transaction');
      assert.throws(
        () =>
          store.transaction(() => {
            const batch = records(first, 4);
            for (const table of scopedTables) store.put(table, batch[table]);
            store.update('sessions', first.id, { title: 'uncommitted title' });
            store.event(batch.runs.id, first.id, 'snapshot.transaction', { uncommitted: true });
            const visible = store.sessionSnapshots.read(first.id);
            assert.equal(visible.session.title, 'uncommitted title');
            assert.equal(visible.events.at(-1)?.payload.uncommitted, true);
            for (const table of scopedTables)
              assert.equal(visible[table].at(-1)?.id, batch[table].id, table);
            assert.deepEqual(
              store.sessionSnapshots.read(second.id),
              legacySnapshot(store.db, second.id),
            );
            throw abort;
          }),
        (error) => error === abort,
      );
      assert.deepEqual(store.sessionSnapshots.read(first.id), before);
      store.transaction(() => {
        store.update('sessions', first.id, { title: 'committed title' });
        store.put('messages', records(first, 4).messages);
      });
      const committed = store.sessionSnapshots.read(first.id);
      assert.equal(committed.session.title, 'committed title');
      assert.equal(committed.messages.length, before.messages.length + 1);
      store.close();
      store = new Store(data);
      assert.deepEqual(store.sessionSnapshots.read(first.id), committed);
      assert.throws(
        () => store.sessionSnapshots.read(randomUUID()),
        (error) => error instanceof AppError && error.code === 'NOT_FOUND' && error.status === 404,
      );
    } finally {
      store.close();
    }
  }));

test('generated session and attachment visibility columns follow JSON updates without duplicate writes', async () =>
  temporary(async (directory) => {
    const store = new Store(join(directory, 'data'));
    try {
      const { first, second } = seed(store.put.bind(store), directory);
      const moved = records(first, 0);
      store.transaction(() => {
        for (const table of scopedTables)
          store.update(table, moved[table].id, { sessionId: second.id });
      });
      const source = store.sessionSnapshots.read(first.id);
      const target = store.sessionSnapshots.read(second.id);
      for (const table of scopedTables) {
        assert.ok(
          source[table].every((item) => item.id !== moved[table].id),
          table,
        );
        assert.equal(target[table][0]?.id, moved[table].id, table);
      }
      store.update('attachments', moved.attachments.id, { removed: true });
      assert.ok(
        store.sessionSnapshots
          .read(second.id)
          .attachments.every((item) => item.id !== moved.attachments.id),
      );
      store.update('attachments', moved.attachments.id, { status: 'used' });
      assert.equal(store.sessionSnapshots.read(second.id).attachments[0]?.id, moved.attachments.id);
      assert.deepEqual(store.sessionSnapshots.read(second.id), legacySnapshot(store.db, second.id));
    } finally {
      store.close();
    }
  }));

test('actual snapshot session queries use indexed SEARCH rather than table SCAN', async (t) =>
  temporary(async (directory) => {
    const store = new Store(join(directory, 'data'));
    try {
      const { first } = seed(store.put.bind(store), directory);
      const queries: { query: string; bindings: Bindings }[] = [];
      const prepare = store.db.prepare.bind(store.db);
      const mocked = t.mock.method(store.db, 'prepare', (query: string) => {
        const statement = prepare(query);
        if (/^select\b/iu.test(query)) {
          const all = statement.all.bind(statement);
          t.mock.method(statement, 'all', (...bindings: Bindings) => {
            queries.push({ query, bindings });
            return all(...bindings);
          });
        }
        return statement;
      });
      store.sessionSnapshots.read(first.id);
      mocked.mock.restore();
      for (const table of [...scopedTables, 'subagents']) {
        const query = queries.find((item) =>
          new RegExp(`\\bfrom\\s+["\x60]?${table}["\x60]?\\b`, 'iu').test(item.query),
        );
        assert.ok(query, `Capture the repository query for ${table}`);
        assert.match(query.query, /session_id/iu);
        assert.match(
          query.query,
          table === 'subagents' ? /order by.*started_at.*id/iu : /order by.*rowid/iu,
        );
        const plan = prepare(`EXPLAIN QUERY PLAN ${query.query}`).all(...query.bindings) as {
          detail: string;
        }[];
        const details = plan.map((item) => item.detail).join('\n');
        const index = table === 'subagents' ? 'subagents_session' : `${table}_snapshot_session`;
        assert.match(details, new RegExp(`SEARCH ${table} USING INDEX ${index}`, 'iu'));
        assert.doesNotMatch(details, /\bSCAN\b/iu, table);
      }
    } finally {
      t.mock.restoreAll();
      store.close();
    }
  }));

function subagent(session: Session, position: number, startedAt = at): Subagent {
  return {
    id: `${session.id}-task-${position}`,
    runId: records(session, position % 4).runs.id,
    sessionId: session.id,
    kind: position % 2 ? 'worker' : 'explore',
    title: `Task ${position}`,
    status: 'running',
    summary: null,
    startedAt,
    endedAt: null,
  };
}

test('subagent snapshots retain ordered session history and terminal summaries across reopen', async () =>
  temporary(async (directory) => {
    const data = join(directory, 'data');
    const { app, get } = await serve(data);
    let sessionId: string;
    let expected: Subagent[];
    try {
      const { first, second, outside, empty } = seed(app.store.put.bind(app.store), directory);
      sessionId = first.id;
      const tasks = [subagent(first, 3), subagent(first, 2), subagent(first, 1, earlier)];
      for (const item of tasks) app.store.startSubagent(item);
      const foreign = subagent(second, 0);
      app.store.startSubagent(foreign);
      app.store.startSubagent(subagent(outside, 0));
      const done = tasks[1];
      assert.ok(done);
      app.store.finishSubagent(done.id, done.runId, 'completed', 'Found the relevant records.');
      expected = app.store.sessionSnapshots.read(first.id).subagents;
      assert.deepEqual(
        expected.map((item) => item.id),
        [tasks[2]?.id, tasks[1]?.id, tasks[0]?.id],
      );
      assert.equal(expected[1]?.summary, 'Found the relevant records.');
      assert.ok(expected[1]?.endedAt);
      const body = await get(first.id);
      assert.ok(body && typeof body === 'object' && 'subagents' in body);
      assert.deepEqual(body.subagents, expected);
      assert.deepEqual(app.store.sessionSnapshots.read(second.id).subagents, [foreign]);
      assert.deepEqual(app.store.sessionSnapshots.read(empty.id).subagents, []);
    } finally {
      await app.close();
    }
    const reopened = new Store(data);
    try {
      assert.deepEqual(reopened.sessionSnapshots.read(sessionId).subagents, expected);
    } finally {
      reopened.close();
    }
  }));

test('subagent start and finish are idempotent and reject conflicting identities and wrong run completions', async () =>
  temporary(async (directory) => {
    const store = new Store(join(directory, 'data'));
    try {
      const { first, second } = seed(store.put.bind(store), directory);
      const task = subagent(first, 0);
      store.startSubagent(task);
      store.startSubagent(task);
      const cursor = store.cursor();
      assert.throws(() => store.startSubagent({ ...task, sessionId: second.id }), {
        code: 'SUBAGENT_CONFLICT',
      });
      assert.throws(
        () => store.startSubagent({ ...task, id: randomUUID(), sessionId: second.id }),
        /FOREIGN KEY/iu,
      );
      assert.throws(
        () => store.startSubagent({ ...task, id: randomUUID(), runId: 'missing' }),
        /FOREIGN KEY/iu,
      );
      assert.throws(() => store.startSubagent({ ...task, status: 'completed', endedAt: at }), {
        code: 'INVALID_SUBAGENT_STATE',
      });
      store.finishSubagent(task.id, records(second, 0).runs.id, 'completed', 'Wrong run');
      store.finishSubagent('missing', task.runId, 'failed', null);
      assert.equal(store.cursor(), cursor);
      assert.deepEqual(store.sessionSnapshots.read(first.id).subagents, [task]);
      const terminal = ['completed', 'failed', 'stopped', 'interrupted'] as const;
      for (const [index, status] of terminal.entries()) {
        const item = index === 0 ? task : subagent(first, index);
        if (index !== 0) store.startSubagent(item);
        const summary = index % 2 ? null : `Result ${index}`;
        store.finishSubagent(item.id, item.runId, status, summary);
        const before = store.sessionSnapshots.read(first.id).subagents;
        const finished = before.find((value) => value.id === item.id);
        assert.equal(finished?.status, status);
        assert.equal(finished?.summary, summary);
        assert.ok(finished?.endedAt);
        const endCursor = store.cursor();
        store.finishSubagent(item.id, item.runId, 'failed', 'Late result');
        store.startSubagent(item);
        assert.equal(store.cursor(), endCursor);
        assert.deepEqual(store.sessionSnapshots.read(first.id).subagents, before);
      }
      assert.equal(
        store.history(first.id).filter((event) => event.type === 'subagent.started').length,
        4,
      );
      assert.equal(
        store.history(first.id).filter((event) => event.type === 'subagent.finished').length,
        4,
      );
    } finally {
      store.close();
    }
  }));

test('subagent records and events roll back together and notifications observe committed SQLite data', async (t) =>
  temporary(async (directory) => {
    const data = join(directory, 'data');
    const store = new Store(data);
    const observer = new DatabaseSync(join(data, 'atelier.sqlite'), { readOnly: true });
    try {
      const { first } = seed(store.put.bind(store), directory);
      const task = subagent(first, 0);
      const notifications: RunEvent[] = [];
      store.events.on('event', (event: RunEvent) => {
        notifications.push(event);
        assert.equal(
          rows(observer, 'SELECT id FROM events WHERE id=?', String(event.id)).length,
          1,
        );
        if (event.type.startsWith('subagent.')) {
          const persisted = rows(observer, 'SELECT status FROM subagents WHERE id=?', task.id)[0];
          assert.ok(persisted);
          const payload = event.payload.subagent;
          assert.ok(payload && typeof payload === 'object' && 'status' in payload);
          assert.equal(persisted.status, payload.status);
        }
      });
      const abort = new Error('Fail after event insertion');
      const failEvent = () => {
        const original = store.event.bind(store);
        return t.mock.method(store, 'event', (...args: Parameters<Store['event']>) => {
          original(...args);
          throw abort;
        });
      };
      let fault = failEvent();
      assert.throws(
        () => store.startSubagent(task),
        (error) => error === abort,
      );
      fault.mock.restore();
      assert.deepEqual(store.sessionSnapshots.read(first.id).subagents, []);
      assert.deepEqual(store.history(first.id), []);
      assert.equal(notifications.length, 0);
      store.startSubagent(task);
      assert.equal(notifications.length, 1);
      const before = store.sessionSnapshots.read(first.id);
      fault = failEvent();
      assert.throws(
        () => store.finishSubagent(task.id, task.runId, 'completed', 'Uncommitted summary'),
        (error) => error === abort,
      );
      fault.mock.restore();
      assert.deepEqual(store.sessionSnapshots.read(first.id), before);
      assert.equal(notifications.length, 1);
      store.finishSubagent(task.id, task.runId, 'completed', 'Committed summary');
      assert.equal(notifications.length, 2);
    } finally {
      t.mock.restoreAll();
      observer.close();
      store.close();
    }
  }));

test('recover interrupts all running subagents atomically, retains terminal tasks and ignores late results', async (t) =>
  temporary(async (directory) => {
    const data = join(directory, 'data');
    let store = new Store(data);
    try {
      const { first, second } = seed(store.put.bind(store), directory);
      const active = subagent(first, 0);
      const orphaned = subagent(second, 0);
      const done = subagent(first, 1);
      store.update('runs', active.runId, { status: 'running' });
      store.startSubagent(active);
      store.startSubagent(orphaned);
      store.startSubagent(done);
      store.finishSubagent(done.id, done.runId, 'completed', 'Keep this result');
      const completed = store.sessionSnapshots
        .read(first.id)
        .subagents.find((item) => item.id === done.id);
      store.close();
      store = new Store(data);
      const before = store.sessionSnapshots.read(first.id);
      const original = store.event.bind(store);
      const abort = new Error('Abort recovery event');
      const notifications: RunEvent[] = [];
      store.events.on('event', (event: RunEvent) => notifications.push(event));
      const fault = t.mock.method(store, 'event', (...args: Parameters<Store['event']>) => {
        original(...args);
        throw abort;
      });
      assert.throws(
        () => store.recover(),
        (error) => error === abort,
      );
      fault.mock.restore();
      assert.deepEqual(store.sessionSnapshots.read(first.id), before);
      assert.equal(store.sessionSnapshots.read(second.id).subagents[0]?.status, 'running');
      assert.equal(notifications.length, 0);
      store.recover();
      const after = store.sessionSnapshots.read(first.id);
      const interrupted = after.subagents.find((item) => item.id === active.id);
      assert.equal(interrupted?.status, 'interrupted');
      assert.ok(interrupted?.endedAt);
      assert.equal(interrupted?.summary, null);
      assert.deepEqual(
        after.subagents.find((item) => item.id === done.id),
        completed,
      );
      assert.equal(store.sessionSnapshots.read(second.id).subagents[0]?.status, 'interrupted');
      assert.equal(store.get('runs', active.runId).status, 'interrupted');
      assert.deepEqual(after.tools, before.tools);
      assert.deepEqual(after.artifacts, before.artifacts);
      assert.equal(notifications.filter((event) => event.type === 'subagent.finished').length, 2);
      const cursor = store.cursor();
      store.recover();
      store.finishSubagent(active.id, active.runId, 'completed', 'Late SDK result');
      assert.equal(store.cursor(), cursor);
      assert.deepEqual(store.sessionSnapshots.read(first.id), after);
    } finally {
      t.mock.restoreAll();
      store.close();
    }
  }));

test('v7 subagent migration upgrades v6, preserves records and enforces cascades and query indexes', async () =>
  temporary(async (directory) => {
    const data = join(directory, 'data');
    await mkdir(data);
    const legacy = new DatabaseSync(join(data, 'atelier.sqlite'));
    let fixture: ReturnType<typeof seed>;
    try {
      createV5(legacy);
      fixture = seed(
        (table, item) =>
          legacy
            .prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`)
            .run(item.id, JSON.stringify(item)),
        directory,
      );
      legacy.exec(
        await readFile(
          new URL('../server/db/migrations/0006-session-snapshot-indexes.sql', import.meta.url),
          'utf8',
        ),
      );
      assert.equal(rows(legacy, 'PRAGMA user_version')[0]?.user_version, 6);
    } finally {
      legacy.close();
    }
    for (let opening = 0; opening < 2; opening++) {
      const store = new Store(data);
      try {
        assert.equal(rows(store.db, 'PRAGMA user_version')[0]?.user_version, 10);
        assert.deepEqual(
          store.sessionSnapshots.read(fixture.first.id),
          legacySnapshot(store.db, fixture.first.id),
        );
        if (opening === 0) continue;
        const first = subagent(fixture.first, 0);
        const second = subagent(fixture.first, 1);
        const foreign = subagent(fixture.second, 0);
        store.startSubagent(first);
        store.startSubagent(second);
        store.startSubagent(foreign);
        assert.throws(
          () => store.db.prepare('UPDATE subagents SET status=? WHERE id=?').run('bogus', first.id),
          /CHECK constraint/iu,
        );
        assert.throws(
          () =>
            store.db.prepare('UPDATE subagents SET status=? WHERE id=?').run('completed', first.id),
          /CHECK constraint/iu,
        );
        for (const [query, value, index] of [
          [
            'SELECT * FROM subagents WHERE session_id=? ORDER BY started_at,id',
            fixture.first.id,
            'subagents_session',
          ],
          [
            "SELECT * FROM subagents WHERE run_id=? AND status='running'",
            first.runId,
            'subagents_run',
          ],
        ]) {
          assert.ok(query && value && index);
          const plan = rows(store.db, `EXPLAIN QUERY PLAN ${query}`, value)
            .map((item) => item.detail)
            .join('\n');
          assert.match(plan, new RegExp(`SEARCH subagents USING INDEX ${index}`, 'iu'));
          assert.doesNotMatch(plan, /\bSCAN\b|TEMP B-TREE/iu);
        }
        store.delete('runs', first.runId);
        assert.deepEqual(store.sessionSnapshots.read(fixture.first.id).subagents, [second]);
        store.delete('sessions', fixture.first.id);
        assert.deepEqual(
          rows(store.db, 'SELECT id FROM subagents').map((row) => row.id),
          [foreign.id],
        );
        store.delete('sessions', fixture.second.id);
        assert.deepEqual(rows(store.db, 'SELECT id FROM subagents'), []);
        assert.deepEqual(rows(store.db, 'PRAGMA foreign_key_check'), []);
        assert.equal(rows(store.db, 'PRAGMA quick_check')[0]?.quick_check, 'ok');
      } finally {
        store.close();
      }
    }
  }));
