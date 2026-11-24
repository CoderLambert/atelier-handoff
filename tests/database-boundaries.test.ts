/**
 * @file 验证数据库规则的静态检查。
 * @implementation 用小型源码片段验证仓储导入、原生查询、SQL 模板与遗留调用次数。
 * @updated 2026-11-21T00:00:00+08:00
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseSites, unexpectedSites } from '../scripts/check-database-boundaries.mjs';

const service = 'server/modules/sessions/get-session.ts';
const repo = 'server/db/repositories/sessions.ts';

test('ORM queries are accepted in repositories and rejected in use cases', () => {
  const query =
    "import {eq} from 'drizzle-orm'; const rows = db.select().from(t).where(eq(t.id,id)).all();";
  assert.equal(databaseSites(repo, query).length, 0);
  assert.equal(databaseSites(service, query).length, 1);
  assert.equal(
    databaseSites(service, "import { sessions } from '../../db/schema/sessions.js';").length,
    1,
  );
  assert.equal(databaseSites(repo, "import Database from 'better-sqlite3';").length, 1);
  assert.equal(databaseSites('server/store.ts', "import './db/connection.js';").length, 0);
  assert.equal(
    databaseSites('server/store.ts', "import './db/repositories/session-snapshot.js';").length,
    1,
  );
});

test('raw expressions and dynamic driver access need individual review', () => {
  for (const query of [
    "store.db.prepare('SELECT 1')",
    'db.exec(statement)',
    'db.$client',
    "import { sql as fragment } from 'drizzle-orm'; fragment`count(*)`",
    'sql.raw(value)',
  ])
    assert.ok(databaseSites(repo, query).length, query);
});

test('an existing SQL statement cannot be duplicated, modified, or transferred between modules', () => {
  const text = "store.db.prepare('SELECT id FROM messages WHERE session_id=?');";
  const sites = databaseSites(service, text);
  assert.equal(sites.length, 1);
  const budget = sites.map((site) => site.key);
  assert.deepEqual(unexpectedSites(sites, budget), []);
  assert.equal(unexpectedSites(databaseSites(service, text + text), budget).length, 1);
  assert.equal(
    unexpectedSites(databaseSites(service, text.replace('session_id=?', 'id=?')), budget).length,
    1,
  );
  assert.equal(unexpectedSites(databaseSites(repo, text), []).length, 1);
});

test('a Git commit literal is distinct from a SQL transaction command', () => {
  assert.deepEqual(databaseSites(service, "const target = { kind: 'commit' };"), []);
  assert.equal(databaseSites(service, "db.exec('commit')").length, 1);
  assert.equal(databaseSites(service, "db.exec('COMMIT TRANSACTION')").length, 1);
});
