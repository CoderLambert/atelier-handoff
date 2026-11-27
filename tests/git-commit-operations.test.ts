/**
 * @file 验证多提交 SQLite 仓储的迁移、领取、CAS、授权范围和重启恢复。
 * @implementation 仅使用临时数据根和独立 Node 写进程，核对真实 SQLite 竞争、WAL 重启与旧库回滚；不执行 Git。
 * @updated 2026-11-27T20:15:00+08:00
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.js';
import { dropV11Schema } from './fixtures/downgrade-v11.js';
import { fileIdentity } from '../server/modules/git/git-cli.js';
import {
  commitOperationClaim,
  commitOperationRecord,
  hashCommitRepositoryIdentity,
  CommitOperationRepositoryError,
  type CommitOperationClaim,
  type CommitOperationRecord,
  type CommitOperationScope,
  type CommitOperationUpdate,
} from '../server/modules/git/commit-operation-repository.js';

const projectId = '10000000-0000-4000-8000-000000000001';
const otherProjectId = '10000000-0000-4000-8000-000000000002';
const at = '2026-11-24T00:00:00.000Z';
const scope: CommitOperationScope = {
  projectId,
  repositoryId: hashCommitRepositoryIdentity('/isolated/common\0device:inode'),
  worktreeIdentity: 'tree-device:inode',
  adminIdentity: 'admin-device:inode',
};
function request(overrides: Partial<CommitOperationClaim> = {}): CommitOperationClaim {
  return {
    ...scope,
    operationId: randomUUID(),
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    ref: 'refs/heads/main',
    oldHead: '1'.repeat(40),
    newHead: '3'.repeat(40),
    commits: ['2'.repeat(40), '3'.repeat(40)],
    originalIndex: { file: 'private/original.index', hash: 'b'.repeat(64) },
    targetIndex: { file: 'private/target.index', hash: 'c'.repeat(64) },
    ...overrides,
  };
}
function update(
  operation: CommitOperationRecord,
  state: CommitOperationUpdate['state'] = 'ref_updated',
): CommitOperationUpdate {
  return {
    scope: {
      projectId: operation.projectId,
      repositoryId: operation.repositoryId,
      worktreeIdentity: operation.worktreeIdentity,
      adminIdentity: operation.adminIdentity,
    },
    operationId: operation.operationId,
    requestHash: operation.requestHash,
    expectedRevision: operation.revision,
    expectedState: operation.state,
    state,
    ...(state === 'recovery_required' ? { error: { code: 'INDEX_OWNERSHIP_UNKNOWN' } } : {}),
  };
}
const errorCode = (code: CommitOperationRepositoryError['code']) => (error: unknown) =>
  error instanceof CommitOperationRepositoryError && error.code === code;
function seed(store: Store) {
  for (const id of [projectId, otherProjectId])
    store.put('projects', {
      id,
      name: 'isolated-db-test',
      path: '/isolated-nonexistent/' + id,
      branch: 'main',
      available: true,
      createdAt: at,
    });
}
async function temporary(work: (directory: string) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-commit-operation-'));
  try {
    await work(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
function withStore(directory: string, work: (store: Store) => void) {
  const store = new Store(directory);
  try {
    work(store);
  } finally {
    store.close();
  }
}

const operationColumns =
  'rowid, operation_id, project_id, repository_id, worktree_identity, admin_identity, request_id, request_hash, state, revision, ref, old_head, new_head, commits, original_index_file, original_index_hash, target_index_file, target_index_hash, error_code, created_at, updated_at, finished_at';
async function seedV9(directory: string, variant: 'legacy' | 'current') {
  let preparedRequest = request();
  withStore(directory, (store) => {
    seed(store);
    const repository = store.gitCommitOperations;
    const prepare = (tree: string) =>
      repository.claim(request({ worktreeIdentity: tree })).operation;
    preparedRequest = request({
      worktreeIdentity: 'v9-prepared',
      oldHead: null,
      originalIndex: null,
    });
    repository.claim(preparedRequest);
    repository.compareAndSwap(update(prepare('v9-ref-updated')));
    repository.compareAndSwap(
      update(repository.compareAndSwap(update(prepare('v9-completed'))), 'completed'),
    );
    repository.compareAndSwap(update(prepare('v9-recovery-2'), 'recovery_required'));
    repository.compareAndSwap(
      update(repository.compareAndSwap(update(prepare('v9-recovery-3'))), 'recovery_required'),
    );
    if (variant === 'current') {
      repository.compareAndSwap(update(prepare('v9-aborting'), 'aborting'));
      repository.compareAndSwap(
        update(repository.compareAndSwap(update(prepare('v9-aborted'), 'aborting')), 'aborted'),
      );
    }
    store.db.prepare('UPDATE git_commit_operations SET rowid=rowid*10').run();
    store.db.exec(dropV11Schema);
  });
  let ddl = await readFile(
    new URL('../server/db/migrations/0009-git-commit-operations.sql', import.meta.url),
    'utf8',
  );
  if (variant === 'current')
    ddl = ddl
      .replace(
        "'prepared', 'ref_updated', 'completed', 'recovery_required'",
        "'prepared', 'ref_updated', 'aborting', 'completed', 'aborted', 'recovery_required'",
      )
      .replace(
        "(state='ref_updated' AND revision=2)",
        "(state IN ('ref_updated','aborting') AND revision=2)",
      )
      .replace(
        "(state='completed' AND revision=3)",
        "(state IN ('completed','aborted') AND revision=3)",
      )
      .replace(
        "(state='completed') = (finished_at IS NOT NULL)",
        "(state IN ('completed','aborted')) = (finished_at IS NOT NULL)",
      )
      .replaceAll("WHERE state!='completed';", "WHERE state NOT IN ('completed','aborted');");
  const database = new DatabaseSync(join(directory, 'atelier.sqlite'));
  try {
    database.exec(
      'PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; ALTER TABLE git_commit_operations RENAME TO fixture_operations; DROP INDEX git_commit_request; DROP INDEX git_commit_one_unfinished; DROP INDEX git_commit_unfinished; DROP INDEX git_commit_project_unfinished;',
    );
    database.exec(ddl);
    database.exec(
      `INSERT INTO git_commit_operations (${operationColumns}) SELECT ${operationColumns} FROM fixture_operations ORDER BY rowid; DROP TABLE fixture_operations; COMMIT;`,
    );
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
  return preparedRequest;
}
function operationRows(database: DatabaseSync | Store['db']) {
  return database
    .prepare('SELECT rowid,* FROM git_commit_operations ORDER BY rowid')
    .all()
    .map((row) => ({ ...row }));
}
function operationSchema(database: DatabaseSync | Store['db']) {
  return database
    .prepare(
      "SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='git_commit_operations' ORDER BY type,name",
    )
    .all()
    .map((row) => ({ ...row }));
}

// Separate processes share no JS locks. Both announce open connections before the parent releases them.
async function writer(
  directory: string,
  action: 'claim' | 'update',
  input: CommitOperationClaim | CommitOperationUpdate,
  abrupt = false,
) {
  const storeUrl = new URL('../server/store.ts', import.meta.url).href;
  const script = `
    import { createInterface } from 'node:readline';
    import { Store } from ${JSON.stringify(storeUrl)};
    const store = new Store(process.argv[1]);
    const line = createInterface({ input: process.stdin });
    process.stdout.write('ready\\n');
    line.once('line', () => {
      try {
        const result = store.gitCommitOperations.${action === 'claim' ? 'claim' : 'compareAndSwap'}(${JSON.stringify(input)});
        process.stdout.write(JSON.stringify({ ok: true, result }) + '\\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }) + '\\n');
      }
      ${abrupt ? 'process.exit(0);' : 'store.close(); line.close();'}
    });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script, directory],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let result: unknown;
  lines.on('line', (line) => {
    if (line === 'ready') readyResolve();
    else {
      try {
        result = JSON.parse(line);
      } catch {
        result = line;
      }
    }
  });
  const done = new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('SQLite writer timed out'));
    }, 15_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      readyReject(error);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      lines.close();
      if (code !== 0 || result === undefined) {
        const failure = new Error(`Writer exited ${code}: ${stderr}`);
        readyReject(failure);
        reject(failure);
      } else resolve(result);
    });
  });
  // Keep a premature child failure handled while waiting for all contenders to become ready.
  void done.catch(() => undefined);
  await ready;
  return { release: () => child.stdin.end('go\n'), done };
}
function successes(values: unknown[]) {
  return values.map((value) => {
    assert.ok(typeof value === 'object' && value !== null && 'ok' in value);
    return value;
  });
}

test('v10 empty database stores ordered OIDs, only file references, and revision CAS survives reopen', async () =>
  temporary((directory) => {
    let first: CommitOperationRecord;
    const value = request();
    withStore(directory, (store) => {
      seed(store);
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
      const claimed = store.gitCommitOperations.claim(value);
      assert.equal(claimed.outcome, 'claimed');
      first = claimed.operation;
      assert.equal(first.state, 'prepared');
      assert.equal(first.revision, 1);
      assert.deepEqual(first.commits, value.commits);
      assert.deepEqual(store.gitCommitOperations.findRequest(scope, value.requestId), first);
      assert.equal(store.gitCommitOperations.claim(value).outcome, 'existing');
      assert.throws(
        () => store.gitCommitOperations.claim(request({ projectId: randomUUID() })),
        /FOREIGN KEY/u,
      );
      const raw = store.db.prepare('SELECT * FROM git_commit_operations').get();
      assert.equal(raw?.target_index_file, value.targetIndex.file);
      assert.ok(
        !Object.keys(raw ?? {}).some((key) => /bytes|content|payload|token|credential/u.test(key)),
      );
      assert.throws(
        () => store.gitCommitOperations.compareAndSwap(update(first, 'completed')),
        errorCode('INVALID_TRANSITION'),
      );
      const advanced = store.gitCommitOperations.compareAndSwap(update(first));
      assert.equal(advanced.revision, 2);
      assert.throws(
        () => store.gitCommitOperations.compareAndSwap(update(first)),
        errorCode('REVISION_CONFLICT'),
      );
      assert.equal(store.gitCommitOperations.claim(value).operation.state, 'ref_updated');
    });
    withStore(directory, (store) => {
      const current = store.gitCommitOperations.get(scope, value.operationId);
      assert.ok(current);
      assert.equal(current.state, 'ref_updated');
      const completed = store.gitCommitOperations.compareAndSwap(update(current, 'completed'));
      assert.equal(completed.revision, 3);
      assert.equal(completed.finishedAt, completed.updatedAt);
      assert.deepEqual(store.gitCommitOperations.listUnfinished(scope), []);
      assert.equal(store.gitCommitOperations.claim(value).operation.state, 'completed');
      assert.throws(
        () => store.gitCommitOperations.compareAndSwap(update(completed)),
        errorCode('INVALID_TRANSITION'),
      );
      assert.equal(store.gitCommitOperations.claim(request()).outcome, 'claimed');
    });
  }));

test('Store foreign-key assertion is read-only and succeeds inside a snapshot on a valid SQLite database', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      store.gitCommitOperations.claim(request());
      const before = store.db.prepare('SELECT total_changes() AS changes').get()?.changes;
      const rows = store.db.prepare('SELECT * FROM git_commit_operations').all();
      store.db.exec('PRAGMA query_only=ON;');
      assert.equal(store.assertForeignKeyIntegrity(), undefined);
      store.readTransaction(() => assert.equal(store.assertForeignKeyIntegrity(), undefined));
      assert.equal(store.db.prepare('SELECT total_changes() AS changes').get()?.changes, before);
      assert.deepEqual(store.db.prepare('SELECT * FROM git_commit_operations').all(), rows);
      assert.equal(store.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
      assert.equal(store.db.prepare('PRAGMA query_only').get()?.query_only, 1);
    });
  }));

test('foreign-key assertion rejects an orphan operation invisible to project queries without repairing it', async () =>
  temporary((directory) => {
    const value = request();
    const orphanProject = randomUUID();
    withStore(directory, (store) => {
      seed(store);
      store.gitCommitOperations.claim(value);
      store.db.exec('PRAGMA foreign_keys=OFF;');
      store.db
        .prepare('UPDATE git_commit_operations SET project_id=? WHERE operation_id=?')
        .run(orphanProject, value.operationId);
      store.db.exec('PRAGMA foreign_keys=ON; PRAGMA query_only=ON;');
      assert.deepEqual(store.gitCommitOperations.listForProject(projectId), []);
      const before = store.db.prepare('SELECT total_changes() AS changes').get()?.changes;
      const rows = store.db.prepare('SELECT * FROM git_commit_operations').all();
      const orphan = (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'DATABASE_FOREIGN_KEY_VIOLATION';
      assert.throws(() => store.assertForeignKeyIntegrity(), orphan);
      assert.throws(() => store.readTransaction(() => store.assertForeignKeyIntegrity()), orphan);
      assert.equal(store.db.prepare('SELECT total_changes() AS changes').get()?.changes, before);
      assert.deepEqual(store.db.prepare('SELECT * FROM git_commit_operations').all(), rows);
      assert.equal(store.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
      assert.equal(store.db.prepare('PRAGMA query_only').get()?.query_only, 1);
    });
    withStore(directory, (store) => {
      assert.throws(() => store.assertForeignKeyIntegrity(), /DATABASE_FOREIGN_KEY_VIOLATION/u);
      assert.equal(
        store.db
          .prepare('SELECT project_id FROM git_commit_operations WHERE operation_id=?')
          .get(value.operationId)?.project_id,
        orphanProject,
      );
    });
  }));

test('foreign-key assertion checks older worktree relations even without commit-operation rows', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      const worktreeId = randomUUID();
      store.gitWorktrees.saveWorktree({
        id: worktreeId,
        projectId,
        repositoryId: 'repo',
        mode: 'in_place',
        branch: 'main',
        directoryIdentity: 'tree',
        adminIdentity: 'admin',
        snapshotId: null,
        snapshotDigest: null,
        retained: null,
        rebuildable: [],
      });
      store.assertForeignKeyIntegrity();
      store.db.exec('PRAGMA foreign_keys=OFF;');
      store.db
        .prepare('UPDATE git_worktrees SET project_id=? WHERE id=?')
        .run(randomUUID(), worktreeId);
      store.db.exec('PRAGMA foreign_keys=ON; PRAGMA query_only=ON;');
      assert.throws(() => store.assertForeignKeyIntegrity(), /DATABASE_FOREIGN_KEY_VIOLATION/u);
      assert.deepEqual(store.gitCommitOperations.listForProject(projectId), []);
    });
  }));

test('idempotency checks request hash and immutable evidence, with separate operation/request UUIDs', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      const value = request();
      const first = store.gitCommitOperations.claim(value).operation;
      assert.deepEqual(
        store.gitCommitOperations.claim({ ...value, operationId: randomUUID() }).operation,
        first,
      );
      for (const changed of [
        { requestHash: 'd'.repeat(64) },
        { requestId: randomUUID() },
        { ref: 'refs/heads/other' },
        { commits: ['4'.repeat(40), value.newHead] },
        { originalIndex: null },
        { targetIndex: { ...value.targetIndex, hash: 'd'.repeat(64) } },
      ])
        assert.throws(
          () => store.gitCommitOperations.claim({ ...value, ...changed }),
          errorCode('REQUEST_CONFLICT'),
        );
      assert.throws(
        () =>
          store.gitCommitOperations.compareAndSwap({
            ...update(first),
            requestHash: 'd'.repeat(64),
          }),
        errorCode('REQUEST_CONFLICT'),
      );
      assert.throws(
        () => store.gitCommitOperations.compareAndSwap({ ...update(first), expectedRevision: 2 }),
        errorCode('REVISION_CONFLICT'),
      );
    });
  }));

test('project, repository, tree and admin scope restrict every read and update', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      const value = request();
      const first = store.gitCommitOperations.claim(value).operation;
      for (const changed of [
        { projectId: otherProjectId },
        { repositoryId: hashCommitRepositoryIdentity('foreign-repository') },
        { worktreeIdentity: 'foreign-tree' },
        { adminIdentity: 'foreign-admin' },
      ]) {
        const foreign = { ...scope, ...changed };
        assert.equal(store.gitCommitOperations.get(foreign, value.operationId), undefined);
        assert.equal(store.gitCommitOperations.findRequest(foreign, value.requestId), undefined);
        assert.deepEqual(store.gitCommitOperations.listUnfinished(foreign), []);
        assert.throws(
          () => store.gitCommitOperations.compareAndSwap({ ...update(first), scope: foreign }),
          errorCode('NOT_FOUND'),
        );
        assert.throws(
          () => store.gitCommitOperations.claim({ ...value, ...foreign }),
          errorCode('REQUEST_CONFLICT'),
        );
      }
      assert.deepEqual(store.gitCommitOperations.listUnfinishedForProject(otherProjectId), []);
      const otherProject = store.gitCommitOperations.claim({
        ...value,
        operationId: randomUUID(),
        projectId: otherProjectId,
      });
      assert.equal(otherProject.outcome, 'claimed');
      const otherTree = store.gitCommitOperations.claim({
        ...value,
        operationId: randomUUID(),
        worktreeIdentity: 'other-tree',
      });
      assert.equal(otherTree.outcome, 'claimed');
      // An admin-directory identity change cannot create a second active operation for the same checkout.
      assert.throws(
        () => store.gitCommitOperations.claim(request({ adminIdentity: 'replaced-admin' })),
        errorCode('WORKTREE_BUSY'),
      );
      assert.equal(store.gitCommitOperations.get(scope, value.operationId)?.revision, 1);
    });
  }));

test('recovery_required retains evidence, remains unfinished and blocks a fresh claim after restart', async () =>
  temporary((directory) => {
    const value = request({ originalIndex: null, oldHead: null });
    withStore(directory, (store) => {
      seed(store);
      const first = store.gitCommitOperations.claim(value).operation;
      const blocked = store.gitCommitOperations.compareAndSwap(update(first, 'recovery_required'));
      assert.equal(blocked.error?.code, 'INDEX_OWNERSHIP_UNKNOWN');
      assert.equal(blocked.finishedAt, null);
      assert.throws(() => store.delete('projects', projectId), /FOREIGN KEY/u);
    });
    withStore(directory, (store) => {
      const pending = store.gitCommitOperations.listUnfinishedForProject(projectId);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.state, 'recovery_required');
      assert.equal(pending[0]?.originalIndex, null);
      assert.throws(() => store.gitCommitOperations.claim(request()), errorCode('WORKTREE_BUSY'));
    });
  }));

test('aborting survives writer exit as unfinished; only aborted releases claim and never becomes completed', async () =>
  temporary(async (directory) => {
    const value = request();
    let prepared: CommitOperationRecord | undefined;
    withStore(directory, (store) => {
      seed(store);
      const first = store.gitCommitOperations.claim(value).operation;
      prepared = first;
      assert.throws(
        () => store.gitCommitOperations.compareAndSwap(update(first, 'aborted')),
        errorCode('INVALID_TRANSITION'),
      );
    });
    assert.ok(prepared);
    const child = await writer(directory, 'update', update(prepared, 'aborting'), true);
    child.release();
    assert.ok(successes([await child.done])[0]?.ok);
    withStore(directory, (store) => {
      const repository = store.gitCommitOperations;
      const aborting = repository.get(scope, value.operationId);
      assert.ok(aborting);
      assert.equal(aborting.state, 'aborting');
      assert.equal(aborting.revision, 2);
      assert.equal(aborting.finishedAt, null);
      assert.equal(aborting.error, null);
      assert.deepEqual(repository.listUnfinished(scope), [aborting]);
      assert.equal(repository.claim(value).operation.state, 'aborting');
      assert.equal(repository.deleteCompletedForProject(projectId), 0);
      assert.equal(repository.deleteAbortedForProject(projectId), 0);
      assert.throws(() => repository.claim(request()), errorCode('WORKTREE_BUSY'));
      assert.throws(
        () => repository.compareAndSwap(update(aborting, 'completed')),
        errorCode('INVALID_TRANSITION'),
      );
      const aborted = repository.compareAndSwap(update(aborting, 'aborted'));
      assert.equal(aborted.state, 'aborted');
      assert.equal(aborted.revision, 3);
      assert.equal(aborted.finishedAt, aborted.updatedAt);
      assert.equal(aborted.error, null);
      assert.equal(repository.claim(value).operation.state, 'aborted');
      assert.throws(
        () => repository.compareAndSwap(update(aborted, 'ref_updated')),
        errorCode('INVALID_TRANSITION'),
      );
      assert.deepEqual(repository.listUnfinished(scope), []);
      assert.equal(repository.listForProject(projectId)[0]?.state, 'aborted');
    });
    withStore(directory, (store) => {
      const repository = store.gitCommitOperations;
      assert.equal(repository.findRequest(scope, value.requestId)?.state, 'aborted');
      const next = repository.claim(request()).operation;
      assert.equal(next.state, 'prepared');
      assert.equal(repository.deleteCompletedForProject(projectId), 0);
      assert.equal(repository.deleteAbortedForProject(projectId), 1);
      assert.equal(repository.deleteAbortedForProject(projectId), 0);
      assert.deepEqual(repository.get(scope, next.operationId), next);
    });
  }));

test('aborting may become recovery_required but other advanced states cannot begin abandonment', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      const repository = store.gitCommitOperations;
      const aborting = repository.compareAndSwap(
        update(repository.claim(request()).operation, 'aborting'),
      );
      const blocked = repository.compareAndSwap(update(aborting, 'recovery_required'));
      assert.equal(blocked.revision, 3);
      assert.equal(blocked.finishedAt, null);
      assert.equal(blocked.error?.code, 'INDEX_OWNERSHIP_UNKNOWN');
      assert.equal(repository.listUnfinished(scope)[0]?.state, 'recovery_required');
      const advanced = repository.compareAndSwap(
        update(repository.claim(request({ worktreeIdentity: 'advanced-tree' })).operation),
      );
      assert.throws(
        () => repository.compareAndSwap(update(advanced, 'aborting')),
        errorCode('INVALID_TRANSITION'),
      );
      const completed = repository.compareAndSwap(update(advanced, 'completed'));
      assert.throws(
        () => repository.compareAndSwap(update(completed, 'aborting')),
        errorCode('INVALID_TRANSITION'),
      );
      assert.throws(
        () => repository.compareAndSwap(update(blocked, 'aborting')),
        errorCode('INVALID_TRANSITION'),
      );
    });
  }));

test('project migration lists all states with stable bounded pagination and excludes other projects', async () =>
  temporary((directory) => {
    const expectedIds: string[] = [];
    withStore(directory, (store) => {
      seed(store);
      const repository = store.gitCommitOperations;
      const prepared = repository.claim(request({ worktreeIdentity: 'prepared-tree' })).operation;
      const refUpdated = repository.compareAndSwap(
        update(repository.claim(request({ worktreeIdentity: 'ref-updated-tree' })).operation),
      );
      const completed = repository.compareAndSwap(
        update(
          repository.compareAndSwap(
            update(repository.claim(request({ worktreeIdentity: 'completed-tree' })).operation),
          ),
          'completed',
        ),
      );
      const recoveryRequired = repository.compareAndSwap(
        update(
          repository.claim(request({ worktreeIdentity: 'recovery-tree' })).operation,
          'recovery_required',
        ),
      );
      const aborting = repository.compareAndSwap(
        update(
          repository.claim(request({ worktreeIdentity: 'aborting-tree' })).operation,
          'aborting',
        ),
      );
      const aborted = repository.compareAndSwap(
        update(
          repository.compareAndSwap(
            update(
              repository.claim(request({ worktreeIdentity: 'aborted-tree' })).operation,
              'aborting',
            ),
          ),
          'aborted',
        ),
      );
      expectedIds.push(
        ...[prepared, refUpdated, completed, recoveryRequired, aborting, aborted]
          .map((item) => item.operationId)
          .sort(),
      );
      repository.claim(request({ projectId: otherProjectId }));
      store.db
        .prepare(
          "UPDATE git_commit_operations SET created_at=?, updated_at=?, finished_at=CASE WHEN state IN ('completed','aborted') THEN ? ELSE NULL END",
        )
        .run(at, at, at);
    });
    withStore(directory, (store) => {
      const repository = store.gitCommitOperations;
      const all = repository.listForProject(projectId);
      assert.deepEqual(
        all.map((item) => item.operationId),
        expectedIds,
      );
      assert.deepEqual(all.map((item) => item.state).sort(), [
        'aborted',
        'aborting',
        'completed',
        'prepared',
        'recovery_required',
        'ref_updated',
      ]);
      assert.equal(repository.listUnfinishedForProject(projectId).length, 4);
      const firstPage = repository.listForProject(projectId, { limit: 3 });
      const last = firstPage.at(-1);
      assert.ok(last);
      const secondPage = repository.listForProject(projectId, {
        limit: 3,
        after: { createdAt: last.createdAt, operationId: last.operationId },
      });
      assert.deepEqual([...firstPage, ...secondPage], all);
      const final = secondPage.at(-1);
      assert.ok(final);
      assert.deepEqual(
        repository.listForProject(projectId, {
          after: { createdAt: final.createdAt, operationId: final.operationId },
        }),
        [],
      );
      assert.equal(repository.listForProject(otherProjectId).length, 1);
      assert.deepEqual(repository.listForProject(randomUUID()), []);
      assert.throws(() => repository.listForProject('not-a-project-uuid'));
      assert.throws(() => repository.listForProject(projectId, { limit: 201 }));
    });
  }));

test('completed receipt deletion is project scoped and preserves every unfinished state', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      const repository = store.gitCommitOperations;
      const completed = (id: string, tree: string) => {
        const first = repository.claim(
          request({ projectId: id, worktreeIdentity: tree }),
        ).operation;
        const advanced = repository.compareAndSwap(update(first));
        return repository.compareAndSwap(update(advanced, 'completed'));
      };
      const finished = completed(projectId, 'completed-tree');
      const foreignFinished = completed(otherProjectId, 'completed-tree');
      const prepared = repository.claim(request({ worktreeIdentity: 'prepared-tree' })).operation;
      const refUpdated = repository.compareAndSwap(
        update(repository.claim(request({ worktreeIdentity: 'ref-updated-tree' })).operation),
      );
      const recoveryRequired = repository.compareAndSwap(
        update(
          repository.claim(request({ worktreeIdentity: 'recovery-tree' })).operation,
          'recovery_required',
        ),
      );
      const aborting = repository.compareAndSwap(
        update(
          repository.claim(request({ worktreeIdentity: 'aborting-tree' })).operation,
          'aborting',
        ),
      );
      const abort = (id: string) =>
        repository.compareAndSwap(
          update(
            repository.compareAndSwap(
              update(
                repository.claim(request({ projectId: id, worktreeIdentity: 'aborted-tree' }))
                  .operation,
                'aborting',
              ),
            ),
            'aborted',
          ),
        );
      const aborted = abort(projectId);
      const foreignAborted = abort(otherProjectId);
      const expected = [
        prepared.operationId,
        refUpdated.operationId,
        recoveryRequired.operationId,
        aborting.operationId,
      ].sort();
      assert.equal(repository.deleteCompletedForProject(randomUUID()), 0);
      assert.throws(() => repository.deleteCompletedForProject('not-a-project-uuid'));
      assert.equal(repository.deleteCompletedForProject(projectId), 1);
      assert.equal(repository.get(update(finished).scope, finished.operationId), undefined);
      assert.ok(repository.get(update(foreignFinished).scope, foreignFinished.operationId));
      assert.ok(repository.get(update(aborted).scope, aborted.operationId));
      assert.equal(repository.deleteAbortedForProject(projectId), 1);
      assert.equal(repository.get(update(aborted).scope, aborted.operationId), undefined);
      assert.ok(repository.get(update(foreignAborted).scope, foreignAborted.operationId));
      assert.deepEqual(
        repository
          .listUnfinishedForProject(projectId)
          .map((item) => item.operationId)
          .sort(),
        expected,
      );
      assert.equal(repository.deleteCompletedForProject(projectId), 0);
      for (const pending of [prepared, refUpdated, recoveryRequired, aborting]) {
        assert.deepEqual(repository.get(update(pending).scope, pending.operationId), pending);
      }
    });
  }));

test('project deletion can clear completed receipts atomically and rolls back cleanup when unfinished evidence blocks it', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      const repository = store.gitCommitOperations;
      const finish = (id: string) => {
        const first = repository.claim(
          request({ projectId: id, worktreeIdentity: 'finished-tree' }),
        ).operation;
        const advanced = repository.compareAndSwap(update(first));
        return repository.compareAndSwap(update(advanced, 'completed'));
      };
      const finished = finish(projectId);
      const foreignFinished = finish(otherProjectId);
      const pending = repository.claim(request({ worktreeIdentity: 'pending-tree' })).operation;
      assert.throws(
        () =>
          store.transaction(() => {
            assert.equal(repository.deleteCompletedForProject(projectId), 1);
            store.delete('projects', projectId);
          }),
        /FOREIGN KEY/u,
      );
      assert.ok(repository.get(update(finished).scope, finished.operationId));
      assert.ok(repository.get(update(pending).scope, pending.operationId));
      assert.equal(store.get('projects', projectId).id, projectId);
      store.transaction(() => {
        assert.equal(repository.deleteCompletedForProject(otherProjectId), 1);
        store.delete('projects', otherProjectId);
      });
      assert.equal(
        repository.get(update(foreignFinished).scope, foreignFinished.operationId),
        undefined,
      );
      assert.throws(() => store.get('projects', otherProjectId));
      assert.ok(repository.get(update(finished).scope, finished.operationId));
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  }));

test('claim and transition participate in the Store transaction and roll back together', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      const value = request();
      assert.throws(
        () =>
          store.transaction(() => {
            const first = store.gitCommitOperations.claim(value).operation;
            store.gitCommitOperations.compareAndSwap(update(first));
            throw new Error('rollback evidence');
          }),
        /rollback evidence/u,
      );
      assert.equal(store.gitCommitOperations.get(scope, value.operationId), undefined);
      assert.equal(store.gitCommitOperations.claim(value).outcome, 'claimed');
    });
  }));

test('separate SQLite writers atomically claim an identical request once', async () =>
  temporary(async (directory) => {
    withStore(directory, seed);
    const value = request();
    const contenders = await Promise.all([
      writer(directory, 'claim', value),
      writer(directory, 'claim', value),
    ]);
    for (const contender of contenders) contender.release();
    const results = successes(await Promise.all(contenders.map((contender) => contender.done)));
    assert.ok(results.every((result) => result.ok === true));
    const outcomes = results
      .map((value) => {
        assert.ok(
          'result' in value &&
            typeof value.result === 'object' &&
            value.result !== null &&
            'outcome' in value.result,
        );
        return value.result.outcome;
      })
      .sort();
    assert.deepEqual(outcomes, ['claimed', 'existing']);
    withStore(directory, (store) =>
      assert.equal(store.gitCommitOperations.listUnfinished(scope).length, 1),
    );
  }));

test('concurrent reuse of one scoped request UUID with different request hashes reports conflict', async () =>
  temporary(async (directory) => {
    withStore(directory, seed);
    const value = request();
    const contenders = await Promise.all([
      writer(directory, 'claim', value),
      writer(directory, 'claim', {
        ...value,
        operationId: randomUUID(),
        requestHash: 'd'.repeat(64),
      }),
    ]);
    for (const contender of contenders) contender.release();
    const results = successes(await Promise.all(contenders.map((contender) => contender.done)));
    assert.equal(results.filter((item) => item.ok).length, 1);
    assert.ok(results.some((item) => 'code' in item && item.code === 'REQUEST_CONFLICT'));
    withStore(directory, (store) =>
      assert.equal(store.gitCommitOperations.listUnfinished(scope).length, 1),
    );
  }));

test('competing requests and CAS writers have one winner across independent SQLite connections', async () =>
  temporary(async (directory) => {
    withStore(directory, seed);
    const contenders = await Promise.all([
      writer(directory, 'claim', request()),
      writer(directory, 'claim', request()),
    ]);
    for (const contender of contenders) contender.release();
    const claims = successes(await Promise.all(contenders.map((contender) => contender.done)));
    assert.equal(claims.filter((item) => item.ok).length, 1);
    assert.ok(claims.some((item) => 'code' in item && item.code === 'WORKTREE_BUSY'));
    let current: CommitOperationRecord | undefined;
    withStore(directory, (store) => {
      current = store.gitCommitOperations.listUnfinished(scope)[0];
    });
    assert.ok(current);
    const transitions = await Promise.all([
      writer(directory, 'update', update(current)),
      writer(directory, 'update', update(current)),
    ]);
    for (const transition of transitions) transition.release();
    const changed = successes(await Promise.all(transitions.map((transition) => transition.done)));
    assert.equal(changed.filter((item) => item.ok).length, 1);
    assert.ok(changed.some((item) => 'code' in item && item.code === 'REVISION_CONFLICT'));
    withStore(directory, (store) =>
      assert.equal(store.gitCommitOperations.listUnfinished(scope)[0]?.revision, 2),
    );
  }));

test('WAL evidence survives process exit without close, and project recovery paginates tied timestamps', async () =>
  temporary(async (directory) => {
    withStore(directory, seed);
    const value = request();
    const child = await writer(directory, 'claim', value, true);
    child.release();
    assert.ok(successes([await child.done])[0]?.ok);
    let prepared: CommitOperationRecord | undefined;
    withStore(directory, (store) => {
      prepared = store.gitCommitOperations.get(scope, value.operationId);
      assert.equal(prepared?.state, 'prepared');
    });
    assert.ok(prepared);
    const updatedChild = await writer(directory, 'update', update(prepared), true);
    updatedChild.release();
    assert.ok(successes([await updatedChild.done])[0]?.ok);
    withStore(directory, (store) => {
      assert.equal(store.gitCommitOperations.get(scope, value.operationId)?.state, 'ref_updated');
      for (let i = 0; i < 4; i++)
        store.gitCommitOperations.claim(request({ worktreeIdentity: 'tree-' + i }));
      store.db.prepare('UPDATE git_commit_operations SET created_at=?, updated_at=?').run(at, at);
      const all = store.gitCommitOperations.listUnfinishedForProject(projectId);
      const ids: string[] = [];
      let after: { createdAt: string; operationId: string } | undefined;
      for (;;) {
        const page = store.gitCommitOperations.listUnfinishedForProject(projectId, {
          limit: 2,
          after,
        });
        if (!page.length) break;
        ids.push(...page.map((item) => item.operationId));
        const last = page.at(-1);
        assert.ok(last);
        after = { createdAt: last.createdAt, operationId: last.operationId };
      }
      assert.deepEqual(
        ids,
        all.map((item) => item.operationId),
      );
      assert.equal(new Set(ids).size, 5);
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(store.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    });
  }));

test('v8 upgrade preserves old rows and backup bytes; interrupted v9 DDL rolls back and retries', async () =>
  temporary(async (directory) => {
    withStore(directory, (store) => {
      seed(store);
      store.gitWorktrees.saveWorktree({
        id: randomUUID(),
        projectId,
        repositoryId: 'repo',
        mode: 'in_place',
        branch: 'main',
        directoryIdentity: 'tree',
        adminIdentity: 'admin',
        snapshotId: null,
        snapshotDigest: null,
        retained: null,
        rebuildable: [],
      });
      store.db.exec(dropV11Schema);
      store.db.exec('DROP TABLE git_commit_operations; PRAGMA user_version=8;');
    });
    const path = join(directory, 'atelier.sqlite');
    const backupPath = join(directory, 'v8-backup.sqlite');
    await copyFile(path, backupPath);
    const backup = await readFile(backupPath);
    const old = new DatabaseSync(path);
    const before = old.prepare('SELECT rowid,* FROM git_worktrees').all();
    const projectsBefore = old.prepare('SELECT rowid,* FROM projects').all();
    const sql = await readFile(
      new URL('../server/db/migrations/0009-git-commit-operations.sql', import.meta.url),
      'utf8',
    );
    old.exec('BEGIN IMMEDIATE');
    assert.throws(
      () => old.exec(sql + '\nSELECT missing_column FROM git_commit_operations;'),
      /missing_column/u,
    );
    old.exec('ROLLBACK');
    assert.equal(old.prepare('PRAGMA user_version').get()?.user_version, 8);
    assert.equal(
      old.prepare("SELECT name FROM sqlite_master WHERE name='git_commit_operations'").get(),
      undefined,
    );
    old.close();
    withStore(directory, (store) => {
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.deepEqual(
        store.db
          .prepare('SELECT rowid,* FROM git_worktrees')
          .all()
          .map((row) => ({ ...row })),
        before.map((row) => ({ ...row })),
      );
      assert.deepEqual(
        store.db
          .prepare('SELECT rowid,* FROM projects')
          .all()
          .map((row) => ({ ...row })),
        projectsBefore.map((row) => ({ ...row })),
      );
      assert.equal(store.gitCommitOperations.claim(request()).outcome, 'claimed');
      assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(store.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    });
    withStore(directory, (store) =>
      assert.equal(store.gitCommitOperations.listUnfinished(scope).length, 1),
    );
    assert.deepEqual(await readFile(backupPath), backup);
    const retained = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(retained.prepare('PRAGMA user_version').get()?.user_version, 8);
    } finally {
      retained.close();
    }
  }));

for (const variant of ['legacy', 'current'] as const) {
  test(`${variant} v9 DDL and records upgrade to v10 atomically while WAL readers and backups retain v9`, async () =>
    temporary(async (directory) => {
      const preparedRequest = await seedV9(directory, variant);
      const path = join(directory, 'atelier.sqlite');
      const backupPath = join(directory, 'v9-backup.sqlite');
      await copyFile(path, backupPath);
      const backupBytes = await readFile(backupPath);
      const reader = new DatabaseSync(path, { readOnly: true });
      try {
        reader.exec('BEGIN');
        assert.equal(reader.prepare('PRAGMA user_version').get()?.user_version, 9);
        const rows = operationRows(reader);
        const schema = operationSchema(reader);
        const tableSql = String(
          reader.prepare("SELECT sql FROM sqlite_schema WHERE name='git_commit_operations'").get()
            ?.sql,
        );
        assert.equal(tableSql.includes("'aborting'"), variant === 'current');
        assert.equal(rows.length, variant === 'legacy' ? 5 : 7);
        withStore(directory, (store) => {
          assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
          assert.deepEqual(operationRows(store.db), rows);
          store.assertForeignKeyIntegrity();
          assert.equal(store.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
          assert.equal(store.db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
          const indexes = store.db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'git_commit_%' ORDER BY name",
            )
            .all();
          assert.deepEqual(
            indexes.map((row) => row.name),
            [
              'git_commit_one_unfinished',
              'git_commit_project_unfinished',
              'git_commit_request',
              'git_commit_unfinished',
            ],
          );
          assert.ok(
            String(
              store.db
                .prepare("SELECT sql FROM sqlite_schema WHERE name='git_commit_one_unfinished'")
                .get()?.sql,
            ).includes("'aborted'"),
          );
        });
        assert.equal(reader.prepare('PRAGMA user_version').get()?.user_version, 9);
        assert.deepEqual(operationRows(reader), rows);
        assert.deepEqual(operationSchema(reader), schema);
        reader.exec('COMMIT');
        assert.equal(reader.prepare('PRAGMA user_version').get()?.user_version, 11);
        const upgradedSchema = operationSchema(reader);
        withStore(directory, (store) => {
          assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
          assert.deepEqual(operationRows(store.db), rows);
          assert.deepEqual(operationSchema(store.db), upgradedSchema);
          const prepared = store.gitCommitOperations.get(
            { ...scope, worktreeIdentity: preparedRequest.worktreeIdentity },
            preparedRequest.operationId,
          );
          assert.ok(prepared);
          const aborting = store.gitCommitOperations.compareAndSwap(update(prepared, 'aborting'));
          assert.equal(aborting.finishedAt, null);
          const aborted = store.gitCommitOperations.compareAndSwap(update(aborting, 'aborted'));
          assert.equal(aborted.finishedAt, aborted.updatedAt);
          assert.equal(store.gitCommitOperations.claim(preparedRequest).operation.state, 'aborted');
          assert.equal(
            store.gitCommitOperations.claim(
              request({ worktreeIdentity: preparedRequest.worktreeIdentity }),
            ).outcome,
            'claimed',
          );
        });
        assert.deepEqual(await readFile(backupPath), backupBytes);
        const backup = new DatabaseSync(backupPath, { readOnly: true });
        try {
          assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 9);
          assert.deepEqual(operationRows(backup), rows);
          assert.deepEqual(operationSchema(backup), schema);
        } finally {
          backup.close();
        }
      } finally {
        reader.close();
      }
    }));
}

test('v10 rebuild rolls back original v9 DDL, rowids and indexes after a failure past DROP and retries cleanly', async () =>
  temporary(async (directory) => {
    await seedV9(directory, 'legacy');
    const path = join(directory, 'atelier.sqlite');
    const database = new DatabaseSync(path);
    const rows = operationRows(database);
    const schema = operationSchema(database);
    const sql = await readFile(
      new URL('../server/db/migrations/0010-git-commit-operation-lifecycle.sql', import.meta.url),
      'utf8',
    );
    try {
      database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
      assert.throws(
        () => database.exec(sql + '\nSELECT missing_column FROM git_commit_operations;'),
        /missing_column/u,
      );
      database.exec('ROLLBACK');
      assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 9);
      assert.deepEqual(operationRows(database), rows);
      assert.deepEqual(operationSchema(database), schema);
      assert.equal(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name='git_commit_operations_v10'")
          .get(),
        undefined,
      );
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      database.close();
    }
    withStore(directory, (store) => {
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.deepEqual(operationRows(store.db), rows);
      store.assertForeignKeyIntegrity();
    });
  }));

test('v10 copy rejects orphan v9 evidence and Store rollback preserves the original database for repair', async () =>
  temporary(async (directory) => {
    const value = await seedV9(directory, 'legacy');
    const path = join(directory, 'atelier.sqlite');
    const database = new DatabaseSync(path);
    const validRows = operationRows(database);
    const schema = operationSchema(database);
    database.exec('PRAGMA foreign_keys=OFF;');
    database
      .prepare('UPDATE git_commit_operations SET project_id=? WHERE operation_id=?')
      .run(randomUUID(), value.operationId);
    const orphanRows = operationRows(database);
    database.close();
    assert.throws(() => new Store(directory), /FOREIGN KEY/u);
    const retained = new DatabaseSync(path);
    try {
      assert.equal(retained.prepare('PRAGMA user_version').get()?.user_version, 9);
      assert.deepEqual(operationRows(retained), orphanRows);
      assert.deepEqual(operationSchema(retained), schema);
      assert.equal(
        retained
          .prepare("SELECT name FROM sqlite_schema WHERE name='git_commit_operations_v10'")
          .get(),
        undefined,
      );
      retained
        .prepare('UPDATE git_commit_operations SET project_id=? WHERE operation_id=?')
        .run(projectId, value.operationId);
    } finally {
      retained.close();
    }
    withStore(directory, (store) => {
      assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 11);
      assert.deepEqual(operationRows(store.db), validRows);
      store.assertForeignKeyIntegrity();
    });
  }));

test('LocalGit common-path NUL inode identities map deterministically and preserve repository isolation', async () =>
  temporary(async (directory) => {
    const common = join(directory, 'common');
    await mkdir(common);
    const inode = await fileIdentity(common);
    const raw = common + '\0' + inode;
    const repositoryId = hashCommitRepositoryIdentity(raw);
    assert.match(repositoryId, /^[a-f0-9]{64}$/u);
    assert.equal(hashCommitRepositoryIdentity(raw), repositoryId);
    const replacedRepository = hashCommitRepositoryIdentity(common + '\0' + inode + '-replaced');
    assert.notEqual(replacedRepository, repositoryId);
    withStore(join(directory, 'data'), (store) => {
      seed(store);
      const first = store.gitCommitOperations.claim(request({ repositoryId })).operation;
      const authorized = { ...scope, repositoryId };
      assert.equal(
        store.gitCommitOperations.get(authorized, first.operationId)?.repositoryId,
        repositoryId,
      );
      assert.equal(
        store.gitCommitOperations.get(
          { ...authorized, repositoryId: replacedRepository },
          first.operationId,
        ),
        undefined,
      );
      assert.throws(
        () =>
          store.gitCommitOperations.compareAndSwap({
            ...update(first),
            scope: { ...authorized, repositoryId: replacedRepository },
          }),
        errorCode('NOT_FOUND'),
      );
      assert.equal(commitOperationClaim.safeParse(request({ repositoryId: raw })).success, false);
    });
  }));

test('strict runtime schemas reject invalid references, OIDs, credentials, lifecycle and corrupt JSON', async () =>
  temporary((directory) => {
    withStore(directory, (store) => {
      seed(store);
      for (const input of [
        { ...request(), targetIndex: { file: '../escape', hash: 'c'.repeat(64) } },
        { ...request(), targetIndex: { file: '/absolute', hash: 'c'.repeat(64) } },
        { ...request(), targetIndex: { file: 'C:\\index', hash: 'c'.repeat(64) } },
        { ...request(), originalIndex: { file: 'private/target.index', hash: 'c'.repeat(64) } },
        { ...request(), oldHead: '0'.repeat(40) },
        { ...request(), oldHead: null, ref: 'HEAD' },
        { ...request(), ref: 'refs/heads/../other' },
        { ...request(), commits: ['3'.repeat(40), '3'.repeat(40)] },
        { ...request(), credentials: 'must-never-be-stored' },
        {
          ...request(),
          targetIndex: { file: 'index', hash: 'c'.repeat(64), bytes: Buffer.from('secret') },
        },
      ])
        assert.equal(commitOperationClaim.safeParse(input).success, false);
      const first = store.gitCommitOperations.claim(request()).operation;
      assert.equal(commitOperationRecord.safeParse({ ...first, revision: 2 }).success, false);
      const invalidUpdate = {
        ...update(first, 'recovery_required'),
        error: { code: 'BAD', token: 'secret' },
      };
      assert.throws(() => store.gitCommitOperations.compareAndSwap(invalidUpdate));
      assert.throws(() => store.gitCommitOperations.listUnfinished(scope, { limit: 201 }));
      assert.throws(
        () => store.db.prepare("UPDATE git_commit_operations SET state='completed'").run(),
        /CHECK/u,
      );
      assert.throws(
        () => store.db.prepare("UPDATE git_commit_operations SET commits='{}'").run(),
        /CHECK/u,
      );
      store.db
        .prepare('UPDATE git_commit_operations SET commits=?')
        .run(JSON.stringify({ version: 1, oids: ['bad-oid'] }));
      assert.throws(() => store.gitCommitOperations.get(scope, first.operationId));
      assert.throws(() => store.gitCommitOperations.listUnfinishedForProject(projectId));
    });
  }));
