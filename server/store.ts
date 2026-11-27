/**
 * @file 管理工作台 SQLite 数据和运行事件。
 * @implementation 持有 Drizzle 仓储共享的连接及事件事务，按注册表升级架构。运行中断恢复委托 recovery 用例在单事务内完成。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  LATEST_SCHEMA_VERSION,
  openWorkbenchDatabase,
  type LegacyDatabase,
  type SchemaMigration,
  type WorkbenchRepositories,
} from './db/connection.js';
import { recoverInterruptedRuntime } from './modules/runs/recovery.js';
import { subagentSchema, type Subagent } from '../shared/subagents.js';
import { EventEmitter } from 'node:events';
import {
  AppError,
  now,
  type Table,
  type Tables,
  type RunEvent,
  type AppConfig,
} from '../shared/types.js';

const tables: Table[] = [
  'projects',
  'sessions',
  'runs',
  'messages',
  'tools',
  'permissions',
  'artifacts',
  'attachments',
];
export { LATEST_SCHEMA_VERSION, type WorkbenchRepositories };
export class Store {
  readonly db: LegacyDatabase;
  readonly readTransaction: <T>(work: () => T) => T;
  readonly assertForeignKeyIntegrity: () => void;
  readonly repos: WorkbenchRepositories;
  get gitWorktrees() {
    return this.repos.gitWorktrees;
  }
  get gitCommitOperations() {
    return this.repos.gitCommitOperations;
  }
  get sessionSnapshots() {
    return this.repos.sessionSnapshots;
  }
  get sessionEvents() {
    return this.repos.sessionEvents;
  }
  get runReceipts() {
    return this.repos.runReceipts;
  }
  get workspaceLayout() {
    return this.repos.workspaceLayout;
  }
  get shortcutPreferences() {
    return this.repos.shortcutPreferences;
  }
  get gitMultiCommitPreferences() {
    return this.repos.gitMultiCommitPreferences;
  }
  get skillInheritance() {
    return this.repos.skillInheritance;
  }
  get skillToolBindings() {
    return this.repos.skillToolBindings;
  }
  get githubPublicAuth() {
    return this.repos.githubPublicAuth;
  }
  get rtkSettings() {
    return this.repos.rtkSettings;
  }
  readonly events = new EventEmitter();
  private pendingEvents: RunEvent[] | undefined;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const connection = openWorkbenchDatabase(join(directory, 'atelier.sqlite'));
    this.db = connection.db;
    this.readTransaction = connection.readTransaction;
    this.assertForeignKeyIntegrity = connection.assertForeignKeyIntegrity;
    this.repos = connection.repos;
    try {
      this.initialize(connection.migrations);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private initialize(migrations: readonly SchemaMigration[]): void {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > LATEST_SCHEMA_VERSION)
      throw new Error('Database schema is newer than this application.');
    if (version === 0)
      this.transaction(() => {
        for (const table of tables)
          this.db.exec(
            `CREATE TABLE ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;`,
          );
        this.db.exec(`
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(run_id,seq)) STRICT;
        CREATE INDEX events_session ON events(session_id,id);
        CREATE TABLE idempotency (key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, run_id TEXT NOT NULL) STRICT;
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE UNIQUE INDEX project_path ON projects(json_extract(data,'$.path'));
        CREATE INDEX sessions_project ON sessions(json_extract(data,'$.projectId'));
        CREATE INDEX runs_session ON runs(json_extract(data,'$.sessionId'));
        CREATE INDEX messages_session ON messages(json_extract(data,'$.sessionId'));
        PRAGMA user_version=1;
      `);
      });
    if (version < 2)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE extensions (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
      CREATE INDEX extensions_project ON extensions(json_extract(data,'$.projectId'));
      PRAGMA user_version=2;
    `),
      );
    if (version < 3)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
      CREATE TABLE agentRevisions (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
      CREATE INDEX agents_project ON agents(json_extract(data,'$.projectId'));
      CREATE INDEX agent_revisions_project ON agentRevisions(json_extract(data,'$.projectId'));
      CREATE UNIQUE INDEX agent_revision_version ON agentRevisions(json_extract(data,'$.agentId'),json_extract(data,'$.version'));
      CREATE TRIGGER agent_revisions_immutable_update BEFORE UPDATE ON agentRevisions BEGIN
        SELECT RAISE(ABORT, 'Agent revisions are immutable.');
      END;
      CREATE TRIGGER agent_revisions_immutable_delete BEFORE DELETE ON agentRevisions BEGIN
        SELECT RAISE(ABORT, 'Agent revisions are immutable.');
      END;
      PRAGMA user_version=3;
    `),
      );
    if (version < 4)
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE pending_messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          request_key TEXT NOT NULL UNIQUE,
          body_hash TEXT NOT NULL,
          data TEXT NOT NULL CHECK(json_valid(data)),
          withdrawn INTEGER NOT NULL DEFAULT 0,
          paused INTEGER NOT NULL DEFAULT 0,
          error TEXT
        ) STRICT;
        CREATE INDEX pending_messages_session ON pending_messages(session_id, seq) WHERE withdrawn=0;
        PRAGMA user_version=4;
      `),
      );
    if (version < 5)
      this.transaction(() =>
        this.db.exec(`
        ALTER TABLE pending_messages ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE pending_messages ADD COLUMN delivery TEXT CHECK(delivery IN ('waiting','sending','unknown'));
        ALTER TABLE pending_messages ADD COLUMN target_run_id TEXT;
        PRAGMA user_version=5;
      `),
      );
    for (const migration of migrations)
      if (version < migration.version) this.transaction(migration.apply);
    this.events.setMaxListeners(100);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const pending: RunEvent[] = [];
    this.pendingEvents = pending;
    let result: T;
    try {
      result = work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.pendingEvents = undefined;
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.pendingEvents = undefined;
    for (const event of pending) this.events.emit('event', event);
    return result;
  }
  get<K extends Table>(table: K, id: string): Tables[K] {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new AppError('NOT_FOUND', '记录不存在或已删除。', 404);
    return JSON.parse(row.data as string);
  }
  list<K extends Table>(table: K): Tables[K][] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  put<K extends Table>(table: K, value: Tables[K]): Tables[K] {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
      )
      .run(value.id, JSON.stringify(value));
    return value;
  }
  update<K extends Table>(table: K, id: string, changes: Partial<Tables[K]>): Tables[K] {
    return this.put(table, { ...this.get(table, id), ...changes, id });
  }
  delete(table: Table, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
  }
  cursor(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get()!.id);
  }
  event(
    runId: string,
    sessionId: string,
    type: string,
    payload: Record<string, unknown> = {},
  ): RunEvent {
    const seq = Number(
      this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE run_id=?').get(runId)!
        .seq,
    );
    const at = now();
    const insert = this.db
      .prepare('INSERT INTO events(run_id,session_id,seq,type,at,payload) VALUES(?,?,?,?,?,?)')
      .run(runId, sessionId, seq, type, at, JSON.stringify(payload));
    const event = { id: Number(insert.lastInsertRowid), runId, sessionId, seq, type, at, payload };
    if (this.pendingEvents) this.pendingEvents.push(event);
    else this.events.emit('event', event);
    return event;
  }
  since(cursor: number, limit = 1000): RunEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?')
      .all(cursor, limit)
      .map((row) => ({
        id: Number(row.id),
        runId: row.run_id as string,
        sessionId: row.session_id as string,
        seq: Number(row.seq),
        type: row.type as string,
        at: row.at as string,
        payload: JSON.parse(row.payload as string),
      }));
  }
  history(sessionId: string): RunEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE session_id=? ORDER BY id DESC LIMIT 500')
      .all(sessionId)
      .reverse()
      .map((row) => ({
        id: Number(row.id),
        runId: row.run_id as string,
        sessionId: row.session_id as string,
        seq: Number(row.seq),
        type: row.type as string,
        at: row.at as string,
        payload: JSON.parse(row.payload as string),
      }));
  }
  runHistory(runId: string): { events: RunEvent[]; eventCount: number } {
    const eventCount = Number(
      this.db.prepare('SELECT count(*) AS count FROM events WHERE run_id=?').get(runId)!.count,
    );
    const events = this.db
      .prepare(
        "SELECT * FROM events WHERE run_id=? AND type!='message.delta' ORDER BY seq DESC LIMIT 600",
      )
      .all(runId)
      .reverse()
      .map((row) => ({
        id: Number(row.id),
        runId: row.run_id as string,
        sessionId: row.session_id as string,
        seq: Number(row.seq),
        type: row.type as string,
        at: row.at as string,
        payload: JSON.parse(row.payload as string),
      }));
    return { events, eventCount };
  }
  config(): AppConfig {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='config'").get();
    const maxTurns = 16;
    const timeoutMs = 300_000;
    if (row) {
      const saved = JSON.parse(row.value as string) as AppConfig;
      return {
        ...saved,
        // Older settings always saved the numeric defaults, even without user edits.
        limitExecution:
          saved.limitExecution ?? (saved.maxTurns !== maxTurns || saved.timeoutMs !== timeoutMs),
      };
    }
    return {
      gateway: process.env.ATELIER_GATEWAY || 'http://127.0.0.1:3001',
      model: process.env.ATELIER_MODEL || 'gpt-6.1-sol',
      limitExecution: false,
      maxTurns,
      timeoutMs,
    };
  }
  setConfig(config: AppConfig): void {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(config));
  }
  startSubagent(value: Subagent): void {
    const parsed = subagentSchema.parse(value);
    if (parsed.status !== 'running' || parsed.endedAt !== null)
      throw new AppError('INVALID_SUBAGENT_STATE', '子任务必须以运行中状态开始。', 409);
    this.transaction(() => {
      if (this.repos.subagents.start(parsed))
        this.event(parsed.runId, parsed.sessionId, 'subagent.started', { subagent: parsed });
    });
  }
  finishSubagent(
    id: string,
    runId: string,
    status: Exclude<Subagent['status'], 'running'>,
    summary: string | null,
  ): void {
    const terminal = subagentSchema.shape.status.exclude(['running']).parse(status);
    const result = subagentSchema.shape.summary.parse(summary);
    this.transaction(() => {
      const subagent = this.repos.subagents.finish(id, runId, terminal, result, now());
      if (subagent)
        this.event(subagent.runId, subagent.sessionId, 'subagent.finished', { subagent });
    });
  }
  recover(): void {
    recoverInterruptedRuntime(this);
  }
  close(): void {
    this.db.close();
  }
}
