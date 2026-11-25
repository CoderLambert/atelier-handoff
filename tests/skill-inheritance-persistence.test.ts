/**
 * @file 验证本机 Skill 继承设置的 SQLite 持久化。
 * @implementation 使用临时数据目录覆盖默认值、提交与回滚、重启、范围隔离及损坏数据的拒绝授权。
 * @updated 2026-11-25T23:22:56+08:00
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Store } from '../server/store.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atelier-skill-inheritance-'));
  let store: Store | undefined;
  t.after(() => {
    store?.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return () => {
    store?.db.close();
    store = undefined;
    return (store = new Store(directory));
  };
}

test('skill inheritance defaults safely and persists settings without a schema change', (t) => {
  const open = fixture(t);
  let store = open();
  let repo = store.skillInheritance;
  const version = store.db.prepare('PRAGMA user_version').get();
  store.workspaceLayout.saveTheme('nordic');
  assert.equal(repo.readGlobal(), false);
  assert.equal(repo.hostMode('skill'), 'off');
  assert.equal(repo.projectMode('project'), 'follow');
  assert.equal(repo.sessionMode('session', 'skill'), 'follow');
  assert.equal(repo.hostModes().size, 0);
  assert.equal(repo.sessionModes('session').size, 0);

  assert.throws(() => {
    store.transaction(() => {
      repo.setGlobal(true);
      repo.setHostMode('skill', 'auto');
      repo.setProjectMode('project', 'block');
      repo.setSessionMode('session', 'skill', 'manual');
      throw new Error('rollback');
    });
  }, /rollback/);
  assert.equal(repo.readGlobal(), false);
  assert.equal(repo.hostMode('skill'), 'off');
  assert.equal(repo.projectMode('project'), 'follow');
  assert.equal(repo.sessionMode('session', 'skill'), 'follow');

  repo.setGlobal(true);
  repo.setHostMode('skill', 'manual');
  repo.setHostMode('skill', 'manual');
  repo.setHostMode('skill', 'auto');
  repo.setProjectMode('project', 'block');
  repo.setSessionMode('session', 'skill', 'manual');

  store = open();
  repo = store.skillInheritance;
  assert.equal(repo.readGlobal(), true);
  assert.equal(repo.hostMode('skill'), 'auto');
  assert.equal(repo.projectMode('project'), 'block');
  assert.equal(repo.sessionMode('session', 'skill'), 'manual');
  assert.equal(store.workspaceLayout.readTheme(), 'nordic');
  assert.deepEqual(store.db.prepare('PRAGMA user_version').get(), version);

  repo.setGlobal(false);
  assert.equal(repo.readGlobal(), false);
  assert.equal(
    repo.hostMode('skill'),
    'auto',
    'disabling inheritance preserves per-skill preferences',
  );
  repo.setHostMode('skill', 'off');
  repo.setProjectMode('project', 'follow');
  repo.setSessionMode('session', 'skill', 'off');
  assert.equal(repo.sessionMode('session', 'skill'), 'off');
  repo.setSessionMode('session', 'skill', 'follow');

  repo = open().skillInheritance;
  assert.equal(repo.readGlobal(), false);
  assert.equal(repo.hostMode('skill'), 'off');
  assert.equal(repo.projectMode('project'), 'follow');
  assert.equal(repo.sessionMode('session', 'skill'), 'follow');
});

test('batch reads match point reads and keep scopes and opaque identities isolated', (t) => {
  const repo = fixture(t)().skillInheritance;
  const id = '同名_%:"\u0000skill';
  repo.setHostMode(id, 'auto');
  repo.setHostMode('second', 'manual');
  repo.setProjectMode(id, 'block');
  repo.setSessionMode('one', `two:${id}`, 'off');
  repo.setSessionMode('one:two', id, 'manual');
  repo.setSessionMode('one:two', 'second', 'follow');

  assert.equal(repo.projectMode(id), 'block');
  assert.equal(repo.projectMode('unknown'), 'follow');
  assert.equal(repo.sessionMode('ONE:TWO', id), 'follow');
  assert.equal(repo.sessionMode('one', id), 'follow');
  assert.deepEqual(
    repo.hostModes(),
    new Map([
      [id, 'auto'],
      ['second', 'manual'],
    ]),
  );
  assert.deepEqual(repo.sessionModes('one'), new Map([[`two:${id}`, 'off']]));
  assert.deepEqual(
    repo.sessionModes('one:two'),
    new Map([
      [id, 'manual'],
      ['second', 'follow'],
    ]),
  );
  assert.equal(repo.sessionModes('ONE:TWO').size, 0);
  assert.equal(repo.sessionModes('one:two').get(id), repo.sessionMode('one:two', id));
  const snapshot = repo.hostModes();
  repo.setHostMode(id, 'off');
  assert.equal(snapshot.get(id), 'auto');
  assert.equal(repo.hostModes().get(id), repo.hostMode(id));
});

test('malformed settings fail closed for both point reads and batch reads', (t) => {
  const store = fixture(t)();
  const repo = store.skillInheritance;
  const insert = store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
  insert.run('skill-inheritance-v1:global', '"true"');
  insert.run('skill-inheritance-v1:host:"bad"', 'AUTO');
  insert.run('skill-inheritance-v1:host:"\\u0062ad"', 'auto');
  insert.run('skill-inheritance-v1:host:broken-key', 'auto');
  insert.run('skill-inheritance-v1:project:"project"', '"follow"');
  insert.run('skill-inheritance-v1:session:"session":"skill"', 'auto');
  repo.setHostMode('valid', 'manual');

  assert.equal(repo.readGlobal(), false);
  assert.equal(repo.hostMode('bad'), 'off');
  assert.deepEqual(
    repo.hostModes(),
    new Map([
      ['bad', 'off'],
      ['valid', 'manual'],
    ]),
  );
  assert.equal(repo.projectMode('project'), 'block');
  assert.equal(repo.sessionMode('session', 'skill'), 'off');
  assert.deepEqual(repo.sessionModes('session'), new Map([['skill', 'off']]));
  assert.equal(repo.sessionMode('session', 'missing'), 'follow');
});
