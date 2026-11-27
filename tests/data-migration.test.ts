/**
 * @file 验证停机迁入、保留旧数据与运行时写者保护。
 * @implementation 用隔离 SQLite 和真实文件记录重建工作区并核对回退副本。
 * @updated 2026-11-27T20:15:00+08:00
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { FileRecords } from '../server/artifacts.js';
import { fingerprint } from '../server/files.js';
import { migrateWorkspace } from '../server/data-migration.js';
import { acquireDataOwner } from '../server/data-owner.js';
import { Store } from '../server/store.js';
import {
  CommitJournal,
  hashCommitJournalIndex,
  hashCommitJournalRequest,
  type CommitJournalPrepare,
} from '../server/modules/git/commit-journal.js';
import { commitPlanCoordinator } from '../server/modules/git/commit-plan-coordinator.js';
import { dropV11Schema } from './fixtures/downgrade-v11.js';
import { emptyDraft, now, type Run } from '../shared/types.js';

await test('migrate real application records and files while preserving the rollback copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-migration-test-'));
  const source = join(dir, 'old data');
  const target = join(dir, 'new data');
  const project = join(dir, 'project');
  const projectId = randomUUID();
  const sessionId = randomUUID();
  try {
    await mkdir(project);
    let artifactId = '';
    let attachmentId = '';
    let toolId = '';
    const logText = 'retained Bash log\n';
    const store = new Store(source);
    try {
      store.put('projects', {
        id: projectId,
        path: project,
        name: 'fixture',
        available: true,
        branch: '',
        createdAt: now(),
      });
      store.put('sessions', {
        id: sessionId,
        projectId,
        title: 'migration history',
        status: 'active',
        sdkSessionId: null,
        createdAt: now(),
        updatedAt: now(),
        draft: emptyDraft(),
      });
      const run: Run = {
        id: randomUUID(),
        projectId,
        sessionId,
        prompt: 'fixture',
        mode: 'edit',
        status: 'completed',
        createdAt: now(),
        startedAt: now(),
        endedAt: now(),
        reason: null,
        error: null,
        retryOf: null,
        contextPaths: [],
        attachmentIds: [],
        plan: [],
        usage: null,
        config: store.config(),
      };
      store.put('runs', run);
      toolId = `${run.id}:toolu_saved`;
      store.put('tools', {
        id: toolId,
        runId: run.id,
        sessionId,
        name: 'Bash',
        inputSummary: '{}',
        status: 'succeeded',
        output: 'SDK receipt',
        bashLog: {
          status: 'complete',
          bytes: Buffer.byteLength(logText),
          sourceBytes: Buffer.byteLength(logText),
        },
        startedAt: now(),
        endedAt: now(),
      });
      await mkdir(join(source, 'tool-output'), { recursive: true, mode: 0o700 });
      await writeFile(join(source, 'tool-output', `${fingerprint(toolId)}.log`), logText, {
        mode: 0o600,
      });
      const files = new FileRecords(store);
      artifactId = (await files.publish(run, 'result.md', 'migration output')).id;
      attachmentId = (
        await files.upload(
          sessionId,
          'sample.csv',
          Buffer.from('key,value\na,1').toString('base64'),
        )
      ).id;
      await mkdir(join(source, 'sdk', sessionId), { recursive: true });
      await writeFile(join(source, 'sdk', sessionId, 'fixture.jsonl'), '{"event":"fixture"}\n');
    } finally {
      store.close();
    }
    const release = acquireDataOwner(source);
    try {
      await assert.rejects(migrateWorkspace(source, target), /正在|正在使用|正由/);
    } finally {
      release();
    }
    const result = await migrateWorkspace(source, target);
    assert.equal(result.target, target);
    assert.equal(result.files, 4);
    assert.deepEqual(
      [result.projects, result.sessions, result.artifacts, result.attachments],
      [1, 1, 1, 1],
    );
    const opened = new Store(target);
    try {
      const files = new FileRecords(opened);
      assert.equal(opened.get('sessions', sessionId).title, 'migration history');
      assert.equal(await files.toolOutput(toolId, true), logText);
      assert.equal(await files.toolOutput(toolId), 'SDK receipt');
      assert.equal((await files.content(artifactId)).bytes.toString(), 'migration output');
      assert.equal(
        (await files.attachmentContent(attachmentId, sessionId)).bytes.toString(),
        'key,value\na,1',
      );
    } finally {
      opened.close();
    }
    assert.equal(
      await readFile(join(result.backupPath, 'artifacts', artifactId), 'utf8'),
      'migration output',
    );
    assert.equal(await readFile(join(source, 'artifacts', artifactId), 'utf8'), 'migration output');
    await assert.rejects(migrateWorkspace(source, target), /尚未创建/);
    await writeFile(join(source, 'artifacts', artifactId), 'corrupted output');
    const bad = join(dir, 'refused');
    await assert.rejects(migrateWorkspace(source, bad), /校验失败/);
    await assert.rejects(access(bad), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function migrationFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-migration-v10-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'old data');
  const target = join(root, 'new data');
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const store = new Store(source);
  try {
    store.put('projects', {
      id: projectId,
      path: join(root, 'project'),
      name: 'isolated migration fixture',
      available: true,
      branch: 'main',
      createdAt: now(),
    });
    store.put('sessions', {
      id: sessionId,
      projectId,
      title: 'retained history',
      status: 'active',
      sdkSessionId: null,
      createdAt: now(),
      updatedAt: now(),
      draft: { ...emptyDraft(), text: 'retained draft' },
    });
  } finally {
    store.close();
  }
  return { root, source, target, projectId, sessionId };
}

type FixtureCommitState =
  'prepared' | 'ref_updated' | 'completed' | 'recovery_required' | 'aborting' | 'aborted';
async function commitFixture(
  t: TestContext,
  state: FixtureCommitState = 'completed',
  options: { originalIndex?: Buffer | null; authoritative?: boolean } = {},
) {
  const fixture = await migrationFixture(t);
  const store = new Store(fixture.source);
  const journal = new CommitJournal(fixture.source);
  const original =
    options.originalIndex === undefined ? Buffer.from([0, 255, 17, 128]) : options.originalIndex;
  const target = Buffer.from([0, 128, 18, 255]);
  const requestDigest = hashCommitJournalRequest({ confirmedPreview: 'independent digest' });
  const value: CommitJournalPrepare = {
    operationId: randomUUID(),
    requestHash: hashCommitJournalRequest({ groups: ['one', 'two'], message: 'fixture' }),
    repositoryId: join(fixture.root, 'project', '.git') + '\0' + '1:2',
    worktreeIdentity: '1:3',
    adminIdentity: '1:4',
    indexLockIdentity: '1:5',
    ref: 'refs/heads/main',
    oldHead: 'a'.repeat(40),
    newHead: 'c'.repeat(40),
    commits: ['b'.repeat(40), 'c'.repeat(40)],
    originalIndex: { hash: hashCommitJournalIndex(original), bytes: original },
    targetIndex: { hash: hashCommitJournalIndex(target), bytes: target },
  };
  try {
    const coordinator = commitPlanCoordinator(
      store,
      journal,
      fixture.projectId,
      value.repositoryId,
      value.worktreeIdentity,
      value.adminIdentity,
      requestDigest,
    );
    const writer = options.authoritative === false ? journal : coordinator;
    let evidence = await writer.prepare(value);
    const transition = async (next: Exclude<FixtureCommitState, 'prepared'>) => {
      evidence = await writer.transition({
        operationId: value.operationId,
        requestHash: value.requestHash,
        expectedRevision: evidence.revision,
        state: next,
        ...(next === 'recovery_required' ? { recoveryReason: 'fixture requires recovery' } : {}),
      });
    };
    if (state === 'completed' || state === 'ref_updated') await transition('ref_updated');
    if (state === 'aborted' || state === 'aborting') await transition('aborting');
    if (state === 'completed' || state === 'aborted' || state === 'recovery_required')
      await transition(state);
    return {
      ...fixture,
      value,
      requestDigest,
      evidence,
      journal,
      directory: join(fixture.source, 'commit-journal'),
    };
  } finally {
    store.close();
  }
}

async function fileImages(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(await fileImages(join(directory, entry.name))))
        result[entry.name + '/' + name] = bytes;
    } else result[entry.name] = (await readFile(join(directory, entry.name))).toString('base64');
  }
  return result;
}

async function rewriteJournalOwner(
  directory: string,
  operationId: string,
  owner: unknown,
): Promise<void> {
  for (const revision of [1, 2, 3]) {
    const path = join(directory, operationId + '.' + revision, 'entry.json');
    const decoded: unknown = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded));
    if (owner === undefined) Reflect.deleteProperty(decoded, 'owner');
    else Reflect.set(decoded, 'owner', owner);
    await writeFile(path, JSON.stringify(decoded));
  }
}

async function assertPrivateTree(directory: string): Promise<void> {
  assert.equal((await lstat(directory)).mode & 0o777, 0o700, directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertPrivateTree(path);
    else {
      const info = await lstat(path);
      assert.ok(info.isFile(), path);
      assert.equal(info.mode & 0o777, 0o600, path);
      assert.equal(info.nlink, 1, path);
    }
  }
}

async function assertCommitRefused(
  fixture: { source: string; target: string; root: string },
  code: 'GIT_MIGRATION_COMMIT_INVALID' | 'GIT_MIGRATION_COMMIT_PENDING',
) {
  const database = await readFile(join(fixture.source, 'atelier.sqlite'));
  await assert.rejects(migrateWorkspace(fixture.source, fixture.target), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error);
    assert.equal(error.code, code);
    assert.match(error.message, /保留旧目录/);
    return true;
  });
  await assert.rejects(access(fixture.target), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(fixture.source, 'atelier.sqlite')), database);
  assert.deepEqual(await readdir(fixture.root), ['old data']);
}

await test('v10 migration keeps completed and aborted receipts replayable with all journal evidence', async (t) => {
  for (const state of ['completed', 'aborted'] as const)
    for (const originalIndex of [Buffer.from([0, 255, 10]), Buffer.alloc(0), null])
      await t.test(`${state}, original index ${originalIndex?.length ?? 'absent'}`, async (t) => {
        const fixture = await commitFixture(t, state, { originalIndex });
        assert.notEqual(fixture.value.requestHash, fixture.requestDigest);
        const sourceImages = await fileImages(fixture.directory);
        // Older directory permissions are normalized in each copy, without changing evidence.
        await chmod(fixture.directory, 0o755);
        await chmod(join(fixture.directory, fixture.value.operationId + '.1'), 0o755);
        await chmod(join(fixture.directory, fixture.value.operationId + '.1', 'entry.json'), 0o644);
        const result = await migrateWorkspace(fixture.source, fixture.target);
        assert.equal(result.files, 5);
        for (const directory of [result.target, result.backupPath]) {
          assert.deepEqual(await fileImages(join(directory, 'commit-journal')), sourceImages);
          await assertPrivateTree(directory);
          const store = new Store(directory);
          try {
            const coordinator = commitPlanCoordinator(
              store,
              new CommitJournal(directory),
              fixture.projectId,
              fixture.value.repositoryId,
              fixture.value.worktreeIdentity,
              fixture.value.adminIdentity,
              fixture.requestDigest,
            );
            assert.deepEqual(await coordinator.read(fixture.value.operationId), fixture.evidence);
            assert.deepEqual(await coordinator.unfinished(), []);
            assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
            assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
          } finally {
            store.close();
          }
        }
        assert.deepEqual(await fileImages(fixture.directory), sourceImages);
      });
});

await test('orphan terminal journals survive migration after their project receipt was removed', async (t) => {
  for (const state of ['completed', 'aborted'] as const)
    await t.test(state, async (t) => {
      const fixture = await commitFixture(t, state);
      const store = new Store(fixture.source);
      try {
        const deleted =
          state === 'completed'
            ? store.gitCommitOperations.deleteCompletedForProject(fixture.projectId)
            : store.gitCommitOperations.deleteAbortedForProject(fixture.projectId);
        assert.equal(deleted, 1);
        store.delete('sessions', fixture.sessionId);
        store.delete('projects', fixture.projectId);
      } finally {
        store.close();
      }
      const expected = await fileImages(fixture.directory);
      const result = await migrateWorkspace(fixture.source, fixture.target);
      assert.deepEqual(await fileImages(join(result.target, 'commit-journal')), expected);
      assert.deepEqual(
        await new CommitJournal(result.target).read(fixture.value.operationId),
        fixture.evidence,
      );
    });
});

await test('journal owner binds terminal evidence to the database project and preview digest', async (t) => {
  for (const field of ['projectId', 'requestDigest'] as const)
    await t.test(field, async (t) => {
      const fixture = await commitFixture(t);
      assert.deepEqual(fixture.evidence.owner, {
        projectId: fixture.projectId,
        requestDigest: fixture.requestDigest,
      });
      const owner = {
        projectId: field === 'projectId' ? randomUUID() : fixture.projectId,
        requestDigest: field === 'requestDigest' ? 'f'.repeat(64) : fixture.requestDigest,
      };
      await rewriteJournalOwner(fixture.directory, fixture.value.operationId, owner);
      await assertCommitRefused(fixture, 'GIT_MIGRATION_COMMIT_INVALID');
    });
});

await test('legacy ownerless terminal journals retain distinct execution and preview request digests', async (t) => {
  const fixture = await commitFixture(t);
  await rewriteJournalOwner(fixture.directory, fixture.value.operationId, undefined);
  const expected = await fixture.journal.read(fixture.value.operationId);
  assert.ok(expected);
  assert.equal(expected.owner, undefined);
  assert.notEqual(expected.requestHash, fixture.requestDigest);
  const result = await migrateWorkspace(fixture.source, fixture.target);
  assert.deepEqual(
    await new CommitJournal(result.target).read(fixture.value.operationId),
    expected,
  );
  const store = new Store(result.target);
  try {
    assert.equal(
      store.gitCommitOperations.listForProject(fixture.projectId)[0]?.requestHash,
      fixture.requestDigest,
    );
    const coordinator = commitPlanCoordinator(
      store,
      new CommitJournal(result.target),
      fixture.projectId,
      fixture.value.repositoryId,
      fixture.value.worktreeIdentity,
      fixture.value.adminIdentity,
      fixture.requestDigest,
    );
    assert.deepEqual(await coordinator.read(fixture.value.operationId), expected);
  } finally {
    store.close();
  }
});

await test('every unfinished database or standalone journal state blocks migration and retains old evidence', async (t) => {
  for (const state of ['prepared', 'ref_updated', 'recovery_required', 'aborting'] as const)
    for (const authoritative of [true, false])
      await t.test(`${state}, database receipt ${authoritative}`, async (t) => {
        const fixture = await commitFixture(t, state, { authoritative });
        const expected = await fileImages(fixture.directory);
        await assertCommitRefused(fixture, 'GIT_MIGRATION_COMMIT_PENDING');
        assert.deepEqual(await fileImages(fixture.directory), expected);
      });
});

await test('interrupted journal publication blocks migration even beside completed operations', async (t) => {
  const fixture = await commitFixture(t);
  const pending = join(fixture.directory, '.pending-' + randomUUID());
  await mkdir(pending, { mode: 0o700 });
  await writeFile(join(pending, 'original.index'), Buffer.from([0, 128, 255]), { mode: 0o600 });
  const expected = await fileImages(fixture.directory);
  await assertCommitRefused(fixture, 'GIT_MIGRATION_COMMIT_PENDING');
  assert.deepEqual(await fileImages(fixture.directory), expected);
});

await test('standalone terminal evidence and absent-index backup files are still fully validated', async (t) => {
  await t.test(
    'unreferenced completed journal with a corrupt independent target index',
    async (t) => {
      const fixture = await commitFixture(t, 'completed', { authoritative: false });
      await writeFile(
        join(fixture.directory, fixture.value.operationId + '.1', 'target.index'),
        'corrupt',
      );
      await assertCommitRefused(fixture, 'GIT_MIGRATION_COMMIT_INVALID');
    },
  );
  await t.test(
    'an originally absent index still requires its zero-byte evidence file',
    async (t) => {
      const fixture = await commitFixture(t, 'completed', { originalIndex: null });
      await rm(join(fixture.directory, fixture.value.operationId + '.1', 'original.index'));
      await assertCommitRefused(fixture, 'GIT_MIGRATION_COMMIT_INVALID');
    },
  );
});

await test('missing and corrupt journal evidence blocks publication without deleting source files', async (t) => {
  const mutations: Record<
    string,
    (fixture: Awaited<ReturnType<typeof commitFixture>>) => Promise<void>
  > = {
    'entire journal': (fixture) => rm(fixture.directory, { recursive: true }),
    'first revision': (fixture) =>
      rm(join(fixture.directory, fixture.value.operationId + '.1'), { recursive: true }),
    'middle revision': (fixture) =>
      rm(join(fixture.directory, fixture.value.operationId + '.2'), { recursive: true }),
    'original backup missing': (fixture) =>
      rm(join(fixture.directory, fixture.value.operationId + '.1', 'original.index')),
    'target backup missing': (fixture) =>
      rm(join(fixture.directory, fixture.value.operationId + '.1', 'target.index')),
    'original backup corrupt': (fixture) =>
      writeFile(join(fixture.directory, fixture.value.operationId + '.1', 'original.index'), 'bad'),
    'target backup corrupt': (fixture) =>
      writeFile(join(fixture.directory, fixture.value.operationId + '.1', 'target.index'), 'bad'),
    'first record corrupt': (fixture) =>
      writeFile(join(fixture.directory, fixture.value.operationId + '.1', 'entry.json'), '{bad'),
    'latest record missing': (fixture) =>
      rm(join(fixture.directory, fixture.value.operationId + '.3', 'entry.json')),
    'latest record corrupt': (fixture) =>
      writeFile(join(fixture.directory, fixture.value.operationId + '.3', 'entry.json'), '{}'),
    'unrecognized independent file': (fixture) =>
      writeFile(join(fixture.directory, fixture.value.operationId + '.2', 'extra.index'), 'bad'),
    'unrecognized journal entry': (fixture) =>
      writeFile(join(fixture.directory, 'extra.index'), 'bad'),
  };
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, async (t) => {
      const fixture = await commitFixture(t);
      await mutate(fixture);
      const expected = await access(fixture.directory).then(
        () => fileImages(fixture.directory),
        () => undefined,
      );
      await assertCommitRefused(fixture, 'GIT_MIGRATION_COMMIT_INVALID');
      if (expected) assert.deepEqual(await fileImages(fixture.directory), expected);
    });
});

await test('completed database references must agree with the complete journal', async (t) => {
  for (const assignment of [
    "request_hash='" + 'f'.repeat(64) + "'",
    "repository_id='" + 'f'.repeat(64) + "'",
    "worktree_identity='different'",
    "admin_identity='different'",
    "target_index_file='private/missing.index'",
    "original_index_file='private/missing.index'",
    "target_index_hash='" + 'f'.repeat(64) + "'",
    "new_head='" + 'd'.repeat(40) + "'",
    "state='ref_updated',revision=2,finished_at=NULL",
  ])
    await t.test(assignment.split('=')[0] ?? assignment, async (t) => {
      const fixture = await commitFixture(t);
      const db = new DatabaseSync(join(fixture.source, 'atelier.sqlite'));
      try {
        db.exec('UPDATE git_commit_operations SET ' + assignment);
      } finally {
        db.close();
      }
      await assertCommitRefused(
        fixture,
        assignment.startsWith('state=')
          ? 'GIT_MIGRATION_COMMIT_PENDING'
          : 'GIT_MIGRATION_COMMIT_INVALID',
      );
    });
});

await test('preexisting orphan commit receipts fail migration even when their entire project was deleted', async (t) => {
  const fixture = await commitFixture(t);
  const db = new DatabaseSync(join(fixture.source, 'atelier.sqlite'));
  try {
    db.exec('PRAGMA foreign_keys=OFF; DELETE FROM sessions; DELETE FROM projects;');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 1);
  } finally {
    db.close();
  }
  const expected = await fileImages(fixture.directory);
  await assert.rejects(migrateWorkspace(fixture.source, fixture.target), {
    code: 'DATABASE_FOREIGN_KEY_VIOLATION',
    message: /外键.*保留旧目录/,
  });
  await assert.rejects(access(fixture.target), { code: 'ENOENT' });
  assert.deepEqual(await fileImages(fixture.directory), expected);
});

await test('migration rejects links anywhere in journal evidence and preserves external bytes', async (t) => {
  for (const kind of ['journal symlink', 'revision symlink', 'file symlink', 'file hardlink'])
    await t.test(kind, async (t) => {
      const fixture = await commitFixture(t);
      const external = join(fixture.root, 'external');
      const bytes = Buffer.from([0, 255, 128, 33]);
      const evidence = join(fixture.directory, fixture.value.operationId + '.1', 'target.index');
      if (kind === 'journal symlink' || kind === 'revision symlink') {
        await mkdir(external);
        await writeFile(join(external, 'keep'), bytes);
        const path =
          kind === 'journal symlink'
            ? fixture.directory
            : join(fixture.directory, fixture.value.operationId + '.1');
        await rm(path, { recursive: true });
        await symlink(external, path);
      } else {
        await writeFile(external, bytes);
        await rm(evidence);
        if (kind === 'file symlink') await symlink(external, evidence);
        else await link(external, evidence);
      }
      await assert.rejects(
        migrateWorkspace(fixture.source, fixture.target),
        /符号链接|硬链接|普通目录/,
      );
      await assert.rejects(access(fixture.target), { code: 'ENOENT' });
      assert.deepEqual(
        await readFile(
          kind.endsWith('symlink') && kind !== 'file symlink' ? join(external, 'keep') : external,
        ),
        bytes,
      );
    });
});

async function downgradeFixture(db: DatabaseSync, version: number) {
  if (version < 11) db.exec(dropV11Schema);
  if (version < 9) db.exec('DROP TABLE git_commit_operations');
  if (version === 9) {
    db.exec('DROP TABLE git_commit_operations');
    const historicalSql = await readFile(
      new URL('../server/db/migrations/0009-git-commit-operations.sql', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(historicalSql, /aborting|aborted/);
    db.exec(historicalSql);
  }
  if (version < 8)
    db.exec(
      'DROP TABLE git_session_worktrees; DROP TABLE git_worktree_operations; DROP TABLE git_worktrees;',
    );
  if (version < 7) db.exec('DROP TABLE subagents; DROP INDEX runs_subagent_scope;');
  if (version < 6) {
    db.exec('ALTER TABLE attachments DROP COLUMN snapshot_visible;');
    for (const table of ['runs', 'messages', 'tools', 'permissions', 'artifacts', 'attachments'])
      db.exec(`DROP INDEX ${table}_snapshot_session; ALTER TABLE ${table} DROP COLUMN session_id;`);
    db.exec(
      "CREATE INDEX runs_session ON runs(json_extract(data,'$.sessionId')); CREATE INDEX messages_session ON messages(json_extract(data,'$.sessionId'));",
    );
  }
  if (version < 5)
    db.exec(
      'ALTER TABLE pending_messages DROP COLUMN priority; ALTER TABLE pending_messages DROP COLUMN delivery; ALTER TABLE pending_messages DROP COLUMN target_run_id;',
    );
  if (version < 4) db.exec('DROP TABLE pending_messages;');
  if (version < 3) db.exec('DROP TABLE agentRevisions; DROP TABLE agents;');
  if (version < 2) db.exec('DROP TABLE extensions;');
  db.exec(`PRAGMA user_version=${version};`);
}

await test('versions 1 through 11 migrate real old schemas while rollback copies retain their original version', async (t) => {
  for (let version = 1; version <= 11; version++)
    await t.test('v' + version, async (t) => {
      const fixture = await migrationFixture(t);
      const database = join(fixture.source, 'atelier.sqlite');
      const original = new DatabaseSync(database);
      try {
        await downgradeFixture(original, version);
      } finally {
        original.close();
      }
      const before = await readFile(database);
      const result = await migrateWorkspace(fixture.source, fixture.target);
      assert.deepEqual(await readFile(database), before);
      const backup = new DatabaseSync(join(result.backupPath, 'atelier.sqlite'), {
        readOnly: true,
      });
      try {
        assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, version);
        const row = backup.prepare('SELECT data FROM sessions WHERE id=?').get(fixture.sessionId);
        assert.ok(row);
        assert.equal(JSON.parse(String(row.data)).draft.text, 'retained draft');
      } finally {
        backup.close();
      }
      const migrated = new Store(result.target);
      try {
        assert.equal(migrated.db.prepare('PRAGMA user_version').get()?.user_version, 11);
        assert.equal(migrated.get('sessions', fixture.sessionId).draft.text, 'retained draft');
        assert.deepEqual(migrated.db.prepare('PRAGMA foreign_key_check').all(), []);
      } finally {
        migrated.close();
      }
    });
});

await test('an original four-state v9 database upgrades only the published copy and retains its complete rollback schema', async (t) => {
  const fixture = await commitFixture(t);
  await rewriteJournalOwner(fixture.directory, fixture.value.operationId, undefined);
  const expectedEvidence = await fixture.journal.read(fixture.value.operationId);
  const expectedFiles = await fileImages(fixture.directory);
  const database = join(fixture.source, 'atelier.sqlite');
  const old = new DatabaseSync(database);
  let rows: Record<string, unknown>[] = [];
  let schema: Record<string, unknown>[] = [];
  const rowsQuery = 'SELECT rowid,* FROM git_commit_operations ORDER BY rowid';
  const schemaQuery =
    "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='git_commit_operations' ORDER BY type,name";
  try {
    old.exec('CREATE TEMP TABLE retained_commits AS SELECT * FROM git_commit_operations;');
    await downgradeFixture(old, 9);
    old.exec(
      'INSERT INTO git_commit_operations SELECT * FROM retained_commits; UPDATE git_commit_operations SET rowid=47;',
    );
    rows = old.prepare(rowsQuery).all();
    schema = old.prepare(schemaQuery).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.rowid, 47);
    assert.doesNotMatch(
      String(schema.find((entry) => entry.type === 'table')?.sql),
      /aborting|aborted/,
    );
  } finally {
    old.close();
  }
  const originalBytes = await readFile(database);
  const result = await migrateWorkspace(fixture.source, fixture.target);
  assert.deepEqual(await readFile(database), originalBytes);
  for (const [directory, version] of [
    [result.backupPath, 9],
    [result.target, 11],
  ] as const) {
    const copy = new DatabaseSync(join(directory, 'atelier.sqlite'), { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, version);
      assert.deepEqual(copy.prepare(rowsQuery).all(), rows);
      if (version === 9) assert.deepEqual(copy.prepare(schemaQuery).all(), schema);
      else {
        const table = copy
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='git_commit_operations'",
          )
          .get();
        assert.match(String(table?.sql), /aborting/);
        assert.match(String(table?.sql), /aborted/);
        assert.deepEqual(copy.prepare('PRAGMA foreign_key_check').all(), []);
      }
    } finally {
      copy.close();
    }
    assert.deepEqual(await fileImages(join(directory, 'commit-journal')), expectedFiles);
  }
  const store = new Store(result.target);
  try {
    const coordinator = commitPlanCoordinator(
      store,
      new CommitJournal(result.target),
      fixture.projectId,
      fixture.value.repositoryId,
      fixture.value.worktreeIdentity,
      fixture.value.adminIdentity,
      fixture.requestDigest,
    );
    assert.deepEqual(await coordinator.read(fixture.value.operationId), expectedEvidence);
  } finally {
    store.close();
  }
});

await test('unknown database versions are refused with no destination', async (t) => {
  for (const version of [0, 12])
    await t.test('v' + version, async (t) => {
      const fixture = await migrationFixture(t);
      const database = new DatabaseSync(join(fixture.source, 'atelier.sqlite'));
      try {
        database.exec(`PRAGMA user_version=${version};`);
      } finally {
        database.close();
      }
      await assert.rejects(migrateWorkspace(fixture.source, fixture.target), /版本不支持/);
      await assert.rejects(access(fixture.target), { code: 'ENOENT' });
    });
});

await test('a completed receipt beyond the first 200 rows cannot lose its journal silently', async (t) => {
  const fixture = await commitFixture(t);
  const templates = await Promise.all(
    [1, 2, 3].map((revision) =>
      readFile(
        join(fixture.directory, fixture.value.operationId + '.' + revision, 'entry.json'),
        'utf8',
      ),
    ),
  );
  const store = new Store(fixture.source);
  try {
    const original = store.gitCommitOperations.listForProject(fixture.projectId)[0];
    assert.ok(original);
    const scope = {
      projectId: original.projectId,
      repositoryId: original.repositoryId,
      worktreeIdentity: original.worktreeIdentity,
      adminIdentity: original.adminIdentity,
    };
    const addReceipt = (operationId: string) => {
      const rewrite = (file: string) => file.replaceAll(original.operationId, operationId);
      const initial = store.gitCommitOperations.claim({
        projectId: original.projectId,
        repositoryId: original.repositoryId,
        worktreeIdentity: original.worktreeIdentity,
        adminIdentity: original.adminIdentity,
        operationId,
        requestId: operationId,
        requestHash: original.requestHash,
        ref: original.ref,
        oldHead: original.oldHead,
        newHead: original.newHead,
        commits: original.commits,
        originalIndex: original.originalIndex && {
          hash: original.originalIndex.hash,
          file: rewrite(original.originalIndex.file),
        },
        targetIndex: { hash: original.targetIndex.hash, file: rewrite(original.targetIndex.file) },
      }).operation;
      const advance = store.gitCommitOperations.compareAndSwap({
        scope,
        operationId,
        requestHash: original.requestHash,
        expectedRevision: initial.revision,
        expectedState: initial.state,
        state: 'ref_updated',
      });
      store.gitCommitOperations.compareAndSwap({
        scope,
        operationId,
        requestHash: original.requestHash,
        expectedRevision: advance.revision,
        expectedState: advance.state,
        state: 'completed',
      });
    };
    for (let index = 0; index < 200; index++) {
      const operationId = randomUUID();
      for (const [offset, template] of templates.entries()) {
        const folder = join(fixture.directory, operationId + '.' + (offset + 1));
        await mkdir(folder, { mode: 0o700 });
        await writeFile(
          join(folder, 'entry.json'),
          template.replaceAll(original.operationId, operationId),
          { mode: 0o600 },
        );
        if (offset === 0) {
          await writeFile(
            join(folder, 'original.index'),
            fixture.evidence.originalIndex.bytes ?? Buffer.alloc(0),
            { mode: 0o600 },
          );
          await writeFile(
            join(folder, 'target.index'),
            fixture.evidence.targetIndex.bytes ?? Buffer.alloc(0),
            { mode: 0o600 },
          );
        }
      }
      addReceipt(operationId);
    }
    addReceipt('ffffffff-ffff-4fff-8fff-ffffffffffff');
  } finally {
    store.close();
  }
  await assertCommitRefused(fixture, 'GIT_MIGRATION_COMMIT_INVALID');
});

await test('migration includes committed rows still held only in the source WAL', async (t) => {
  const fixture = await migrationFixture(t);
  const source = new DatabaseSync(join(fixture.source, 'atelier.sqlite'));
  try {
    source.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    source
      .prepare("UPDATE sessions SET data=json_set(data,'$.draft.text',?) WHERE id=?")
      .run('retained WAL draft', fixture.sessionId);
    assert.ok((await lstat(join(fixture.source, 'atelier.sqlite-wal'))).size > 0);
    const result = await migrateWorkspace(fixture.source, fixture.target);
    for (const directory of [result.backupPath, result.target]) {
      const copy = new DatabaseSync(join(directory, 'atelier.sqlite'), { readOnly: true });
      try {
        const row = copy
          .prepare("SELECT json_extract(data,'$.draft.text') AS draft FROM sessions WHERE id=?")
          .get(fixture.sessionId);
        assert.equal(row?.draft, 'retained WAL draft');
      } finally {
        copy.close();
      }
    }
  } finally {
    source.close();
  }
});
