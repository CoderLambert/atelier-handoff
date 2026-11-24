/**
 * @file 验证真实 Git、SQLite 和私有 journal 的多提交中断恢复。
 * @implementation 独立临时仓库中 SIGKILL 执行进程，重开实际 Store 对账并补齐索引；覆盖幂等、双存储分歧及外部引用/索引/锁变化。
 * @updated 2026-11-24T19:00:00+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { fileURLToPath } from 'node:url';
import { CommitJournal, type CommitJournalRecord } from '../server/modules/git/commit-journal.js';
import { hashCommitRepositoryIdentity } from '../server/modules/git/commit-operation-repository.js';
import { compileCommitPlan } from '../server/modules/git/commit-plan-compiler.js';
import { commitPlanCoordinator } from '../server/modules/git/commit-plan-coordinator.js';
import type { CommitPlanExecutionCoordinator } from '../server/modules/git/commit-plan-execution.js';
import {
  abandonCommitPlan,
  recoverCommitPlan,
  type CommitPlanRecoveryOptions,
  type CommitPlanRecoveryCoordinator,
} from '../server/modules/git/commit-plan-recovery.js';
import { readCommitPlanSnapshot } from '../server/modules/git/commit-plan-snapshot.js';
import { fileIdentity, LocalGit } from '../server/modules/git/git-cli.js';

const git = (repo: string, args: string[]) =>
  execFileSync(
    'git',
    [
      '--no-pager',
      '-c',
      'core.hooksPath=' + devNull,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'commit.gpgSign=false',
      '-C',
      repo,
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull,
        GIT_OPTIONAL_LOCKS: '0',
        LANG: 'C',
        LC_ALL: 'C',
      },
    },
  );
interface Fixture {
  repo: string;
  data: string;
  projectId: string;
  git: LocalGit;
  store: Store;
  journal: CommitJournal;
  coordinator(): CommitPlanExecutionCoordinator & CommitPlanRecoveryCoordinator;
}
const requestDigest = 'a'.repeat(64);
async function fixture(work: (value: Fixture) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-multi-recovery-test-'));
  const repo = join(base, 'repo');
  const data = join(base, 'data');
  await mkdir(repo);
  await mkdir(data, { mode: 0o700 });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Recovery fixture']);
  git(repo, ['config', 'user.email', 'recovery@example.test']);
  git(repo, ['config', 'commit.gpgSign', 'false']);
  for (const path of ['selected.txt', 'keep.txt']) await writeFile(join(repo, path), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'initial']);
  const local = await LocalGit.open(repo);
  const rootIdentity = await fileIdentity(repo);
  const adminIdentity = await fileIdentity(local.admin);
  const projectId = randomUUID();
  const value: Fixture = {
    repo,
    data,
    projectId,
    git: local,
    store: new Store(data),
    journal: new CommitJournal(data),
    coordinator: () =>
      commitPlanCoordinator(
        value.store,
        value.journal,
        projectId,
        local.repositoryId,
        rootIdentity,
        adminIdentity,
        requestDigest,
      ),
  };
  value.store.put('projects', {
    id: projectId,
    name: 'Recovery fixture',
    path: repo,
    branch: 'main',
    available: true,
    createdAt: new Date().toISOString(),
  });
  try {
    await work(value);
  } finally {
    value.store.close();
    await rm(base, { recursive: true, force: true });
  }
}
const index = (repo: string) => readFile(join(repo, '.git/index'));
const head = (repo: string) => git(repo, ['rev-parse', 'HEAD']).trim();
type CrashPhase =
  | 'prepared'
  | 'after_ref_before_receipt'
  | 'ref_updated'
  | 'index_published'
  | 'journal_ref_updated'
  | 'journal_completed';
async function crash(
  value: Fixture,
  phase: CrashPhase = 'ref_updated',
  stagedOnly = false,
): Promise<CommitJournalRecord> {
  await writeFile(join(value.repo, 'selected.txt'), 'staged\n');
  git(value.repo, ['add', 'selected.txt']);
  if (!stagedOnly) await writeFile(join(value.repo, 'selected.txt'), 'workspace\n');
  await writeFile(join(value.repo, 'keep.txt'), 'keep staged\n');
  git(value.repo, ['add', 'keep.txt']);
  if (stagedOnly) git(value.repo, ['write-tree']);
  const snapshot = await readCommitPlanSnapshot(value.git);
  const compilation = compileCommitPlan(snapshot, {
    groups: snapshot.units
      .filter((u) => u.path === 'selected.txt')
      .map((u, i) => ({ title: 'Group ' + i, body: '', unitIds: [u.id] })),
    excludedUnitIds: snapshot.units.filter((u) => u.path !== 'selected.txt').map((u) => u.id),
  });
  const operationId = randomUUID();
  const module = (name: string) =>
    new URL('../server/modules/git/' + name + '.ts', import.meta.url).href;
  const script = `
    import {Store} from ${JSON.stringify(new URL('../server/store.ts', import.meta.url).href)};
    import {LocalGit,fileIdentity} from ${JSON.stringify(module('git-cli'))};
    import {CommitJournal} from ${JSON.stringify(module('commit-journal'))};
    import {commitPlanCoordinator} from ${JSON.stringify(module('commit-plan-coordinator'))};
    import {executeCommitPlan} from ${JSON.stringify(module('commit-plan-execution'))};
    const [repo,data,projectId,digest,operationId,phase,snapshot,compilation]=process.argv.slice(1);
    const store=new Store(data); const git=await LocalGit.open(repo);const journal=new CommitJournal(data);
    const base=commitPlanCoordinator(store,journal,projectId,git.repositoryId,await fileIdentity(repo),await fileIdentity(git.admin),digest);
    const coordinator={...base,transition:async input=>{
      if(phase==='after_ref_before_receipt'&&input.state==='ref_updated')process.kill(process.pid,'SIGKILL');
      if(phase==='journal_'+input.state){await journal.transition(input);process.kill(process.pid,'SIGKILL')}
      return base.transition(input);
    }};
    await executeCommitPlan(git,JSON.parse(snapshot),JSON.parse(compilation),{operationId,coordinator,checkpoint:async current=>{if(current===phase)process.kill(process.pid,'SIGKILL')}});
  `;
  value.store.close();
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      value.repo,
      value.data,
      value.projectId,
      requestDigest,
      operationId,
      phase,
      JSON.stringify(snapshot),
      JSON.stringify(compilation),
    ],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 },
  );
  value.store = new Store(value.data);
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const operation = await value.journal.read(operationId);
  assert.ok(operation);
  return operation;
}
async function crashAbandon(
  value: Fixture,
  record: CommitJournalRecord,
  phase: 'aborting' | 'lock_removed' | 'journal_aborting' | 'journal_aborted',
) {
  const module = (name: string) =>
    new URL('../server/modules/git/' + name + '.ts', import.meta.url).href;
  const script = `
    import {Store} from ${JSON.stringify(new URL('../server/store.ts', import.meta.url).href)};
    import {LocalGit,fileIdentity} from ${JSON.stringify(module('git-cli'))};
    import {CommitJournal} from ${JSON.stringify(module('commit-journal'))};
    import {commitPlanCoordinator} from ${JSON.stringify(module('commit-plan-coordinator'))};
    import {abandonCommitPlan} from ${JSON.stringify(module('commit-plan-recovery'))};
    const [repo,data,projectId,digest,operationId,phase]=process.argv.slice(1);
    const store=new Store(data);const git=await LocalGit.open(repo);const journal=new CommitJournal(data);
    const base=commitPlanCoordinator(store,journal,projectId,git.repositoryId,await fileIdentity(repo),await fileIdentity(git.admin),digest);
    const coordinator={...base,transition:async input=>{
      if(phase==='journal_'+input.state){await journal.transition(input);process.kill(process.pid,'SIGKILL')}
      return base.transition(input);
    }};
    await abandonCommitPlan(git,{operationId,journal,coordinator,checkpoint:async current=>{if(current===phase)process.kill(process.pid,'SIGKILL')}});
  `;
  value.store.close();
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      script,
      value.repo,
      value.data,
      value.projectId,
      requestDigest,
      record.operationId,
      phase,
    ],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 },
  );
  value.store = new Store(value.data);
  assert.equal(child.signal, 'SIGKILL', child.stderr);
}
type AheadEdge = 'ref_updated' | 'completed' | 'aborting' | 'aborted';
async function crashAhead(value: Fixture, edge: AheadEdge) {
  if (edge === 'ref_updated' || edge === 'completed')
    return crash(value, edge === 'ref_updated' ? 'journal_ref_updated' : 'journal_completed');
  const before = await crash(value, 'prepared');
  await crashAbandon(value, before, edge === 'aborting' ? 'journal_aborting' : 'journal_aborted');
  const record = await value.journal.read(before.operationId);
  assert.ok(record);
  return record;
}
const options = (value: Fixture, operationId: string): CommitPlanRecoveryOptions => ({
  operationId,
  journal: value.journal,
  coordinator: value.coordinator(),
});
async function withHttp(
  value: Fixture,
  work: (http: { origin: string; prefix: string; csrfToken: string }) => Promise<void>,
) {
  value.store.close();
  const app = await createApp({
    root: fileURLToPath(new URL('../', import.meta.url)),
    data: value.data,
  });
  try {
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrap: unknown = await fetch(origin + '/api/bootstrap').then((response) =>
      response.json(),
    );
    assert.ok(
      bootstrap &&
        typeof bootstrap === 'object' &&
        'csrfToken' in bootstrap &&
        typeof bootstrap.csrfToken === 'string',
    );
    await work({
      origin,
      prefix: `/api/projects/${value.projectId}/git/worktrees/${value.projectId}`,
      csrfToken: bootstrap.csrfToken,
    });
  } finally {
    await app.close();
    value.store = new Store(value.data);
  }
}
const scope = (value: Fixture, record: CommitJournalRecord) => ({
  projectId: value.projectId,
  repositoryId: hashCommitRepositoryIdentity(record.repositoryId),
  worktreeIdentity: record.worktreeIdentity,
  adminIdentity: record.adminIdentity,
});

test('real SIGKILL recovery publishes only owned index and completes actual SQLite/journal state, then replays idempotently', () =>
  fixture(async (value) => {
    const record = await crash(value);
    const beforeHead = head(value.repo);
    const beforeIndex = await index(value.repo);
    assert.equal(record.state, 'ref_updated');
    assert.deepEqual(beforeIndex, record.originalIndex.bytes);
    const phases: string[] = [];
    const result = await recoverCommitPlan(value.git, {
      ...options(value, record.operationId),
      checkpoint: async (phase) => {
        phases.push(phase);
      },
    });
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed') return;
    assert.equal(result.indexPublished, true);
    assert.equal(result.replayed, false);
    assert.equal(result.oid, beforeHead);
    assert.deepEqual(result.commits, record.commits);
    assert.deepEqual(await index(value.repo), record.targetIndex.bytes);
    assert.equal(head(value.repo), beforeHead);
    assert.equal(await readFile(join(value.repo, 'selected.txt'), 'utf8'), 'workspace\n');
    assert.equal((await value.journal.read(record.operationId))?.state, 'completed');
    assert.equal(
      value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.state,
      'completed',
    );
    await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
    const afterIndex = await index(value.repo);
    assert.deepEqual(afterIndex, record.targetIndex.bytes);
    const replay = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(replay.state, 'completed', JSON.stringify(replay));
    if (replay.state === 'completed') {
      assert.equal(replay.replayed, true);
      assert.equal(replay.indexPublished, false);
    }
    assert.deepEqual(await index(value.repo), afterIndex);
    assert.equal(head(value.repo), beforeHead);
    assert.deepEqual(phases, ['observed', 'before_index_publish', 'index_published']);
    // Native diff can refresh index stat data. Verify replay before invoking it.
    assert.equal(git(value.repo, ['diff', '--cached', '--name-only']), 'keep.txt\n');
    assert.equal(git(value.repo, ['diff', '--name-only']), '');
    assert.equal(Object.hasOwn(result, 'operation'), false);
    assert.equal(Object.hasOwn(result, 'originalIndex'), false);
    assert.equal(Object.hasOwn(result, 'targetIndex'), false);
  }));

test('HTTP exposes the interrupted operation and safely recovers it after reopening', () =>
  fixture(async (value) => {
    const record = await crash(value);
    value.store.close();
    const app = await createApp({
      root: fileURLToPath(new URL('../', import.meta.url)),
      data: value.data,
    });
    try {
      await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
      const address = app.server.address();
      assert.ok(address && typeof address === 'object');
      const origin = `http://127.0.0.1:${address.port}`;
      const boot = (await fetch(origin + '/api/bootstrap').then((response) => response.json())) as {
        csrfToken: string;
      };
      const prefix = `/api/projects/${value.projectId}/git/worktrees/${value.projectId}`;
      const pending = await fetch(origin + prefix + '/commit-plan-pending');
      assert.equal(pending.status, 200);
      assert.deepEqual(await pending.json(), {
        items: [{ operationId: record.operationId, state: 'ref_updated', commits: record.commits }],
      });
      const response = await fetch(origin + prefix + '/commit-plan-recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-atelier-token': boot.csrfToken },
        body: JSON.stringify({ operationId: record.operationId }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), {
        operationId: record.operationId,
        commits: record.commits,
      });
      assert.deepEqual(await index(value.repo), record.targetIndex.bytes);
      assert.deepEqual(
        await fetch(origin + prefix + '/commit-plan-pending').then((res) => res.json()),
        { items: [] },
      );
    } finally {
      await app.close();
      value.store = new Store(value.data);
    }
  }));

test('HTTP lists and recovers a real SIGKILL operation whose journal leads SQLite by one receipt', async (context) => {
  for (const edge of ['ref_updated', 'completed'] as const)
    await context.test(edge, () =>
      fixture(async (value) => {
        const record = await crashAhead(value, edge);
        const beforeHead = head(value.repo);
        await withHttp(value, async ({ origin, prefix, csrfToken }) => {
          const pending = await fetch(origin + prefix + '/commit-plan-pending');
          assert.equal(pending.status, 200, await pending.clone().text());
          assert.deepEqual(await pending.json(), {
            items: [
              {
                operationId: record.operationId,
                state: edge === 'ref_updated' ? 'prepared' : 'ref_updated',
                commits: record.commits,
              },
            ],
          });
          const recovered = await fetch(origin + prefix + '/commit-plan-recover', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
            body: JSON.stringify({ operationId: record.operationId }),
          });
          assert.equal(recovered.status, 200, await recovered.clone().text());
          assert.deepEqual(await recovered.json(), {
            operationId: record.operationId,
            commits: record.commits,
          });
          assert.deepEqual(
            await fetch(origin + prefix + '/commit-plan-pending').then((response) =>
              response.json(),
            ),
            { items: [] },
          );
          assert.equal(head(value.repo), beforeHead);
          assert.deepEqual(await index(value.repo), record.targetIndex.bytes);
          assert.equal((await value.journal.read(record.operationId))?.state, 'completed');
        });
        assert.equal(
          value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.state,
          'completed',
        );
      }),
    );
});

test('HTTP explicitly abandons a prepared SIGKILL operation without committing or changing the original index', () =>
  fixture(async (value) => {
    const record = await crash(value, 'prepared');
    const beforeHead = head(value.repo);
    const beforeIndex = await index(value.repo);
    const beforeWorktree = await readFile(join(value.repo, 'selected.txt'));
    await withHttp(value, async ({ origin, prefix, csrfToken }) => {
      assert.deepEqual(
        await fetch(origin + prefix + '/commit-plan-pending').then((response) => response.json()),
        {
          items: [{ operationId: record.operationId, state: 'prepared', commits: record.commits }],
        },
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(origin + prefix + '/commit-plan-abandon', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-atelier-token': csrfToken },
          body: JSON.stringify({ operationId: record.operationId }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(await response.json(), { operationId: record.operationId, aborted: true });
      }
      assert.deepEqual(
        await fetch(origin + prefix + '/commit-plan-pending').then((response) => response.json()),
        { items: [] },
      );
      assert.equal(head(value.repo), beforeHead);
      assert.deepEqual(await index(value.repo), beforeIndex);
      assert.deepEqual(await readFile(join(value.repo, 'selected.txt')), beforeWorktree);
      await assert.rejects(lstat(join(value.git.admin, 'index.lock')), { code: 'ENOENT' });
    });
    assert.equal(
      value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.state,
      'aborted',
    );
  }));

test('crash after reference CAS but before receipt catches up prepared to ref_updated to completed', () =>
  fixture(async (value) => {
    const record = await crash(value, 'after_ref_before_receipt');
    assert.equal(record.state, 'prepared');
    assert.equal(head(value.repo), record.newHead);
    const result = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(result.state, 'completed');
    assert.equal((await value.journal.read(record.operationId))?.revision, 3);
    assert.equal(
      value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.state,
      'completed',
    );
  }));

test('already published target index only receives missing receipts and keeps the exact index inode', () =>
  fixture(async (value) => {
    const record = await crash(value, 'index_published');
    const before = await lstat(join(value.repo, '.git/index'), { bigint: true });
    assert.equal(before.dev + ':' + before.ino, record.indexLockIdentity);
    assert.equal(record.state, 'ref_updated');
    const result = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(result.state, 'completed');
    if (result.state === 'completed') assert.equal(result.indexPublished, false);
    const after = await lstat(join(value.repo, '.git/index'), { bigint: true });
    assert.equal(after.ino, before.ino);
  }));

test('identical original and target hashes still consume the owned pending lock by inode', () =>
  fixture(async (value) => {
    const record = await crash(value, 'ref_updated', true);
    assert.equal(record.originalIndex.hash, record.targetIndex.hash);
    const original = await lstat(join(value.repo, '.git/index'), { bigint: true });
    assert.notEqual(original.dev + ':' + original.ino, record.indexLockIdentity);
    const result = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(result.state, 'completed');
    if (result.state === 'completed') assert.equal(result.indexPublished, true);
    await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
  }));

test('reference not yet advanced never gets reset or committed by recovery', () =>
  fixture(async (value) => {
    const record = await crash(value, 'prepared');
    const before = await index(value.repo);
    const lock = await readFile(join(value.repo, '.git/index.lock'));
    const result = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(result.state, 'recovery_required');
    assert.equal(head(value.repo), record.oldHead);
    assert.deepEqual(await index(value.repo), before);
    assert.deepEqual(await readFile(join(value.repo, '.git/index.lock')), lock);
    assert.equal((await value.journal.read(record.operationId))?.state, 'prepared');
  }));

test('external HEAD, index, missing lock, replaced lock, and changed lock content all preserve evidence', async (context) => {
  for (const change of ['head', 'index', 'missing', 'replaced', 'content'] as const)
    await context.test(change, () =>
      fixture(async (value) => {
        const record = await crash(value);
        const path = join(value.repo, '.git/index.lock');
        if (change === 'head')
          git(value.repo, ['update-ref', record.ref, record.oldHead ?? '', record.newHead]);
        if (change === 'index')
          await writeFile(
            join(value.repo, '.git/index'),
            Buffer.concat([await index(value.repo), Buffer.from('external index')]),
          );
        if (change === 'missing') await unlink(path);
        if (change === 'replaced') {
          await unlink(path);
          await writeFile(path, 'foreign lock');
        }
        if (change === 'content') await writeFile(path, 'different contents, same inode');
        const beforeHead = head(value.repo);
        const beforeIndex = await index(value.repo);
        const beforeLock = await readFile(path).catch(() => null);
        const result = await recoverCommitPlan(value.git, options(value, record.operationId));
        assert.equal(result.state, 'recovery_required');
        assert.equal(head(value.repo), beforeHead);
        assert.deepEqual(await index(value.repo), beforeIndex);
        assert.deepEqual(await readFile(path).catch(() => null), beforeLock);
        assert.equal((await value.journal.read(record.operationId))?.state, 'ref_updated');
      }),
    );
});

test('journal recovery_required and SQLite/journal divergence block publication', async (context) => {
  for (const divergent of [false, true])
    await context.test(String(divergent), () =>
      fixture(async (value) => {
        const record = await crash(value);
        const before = await index(value.repo);
        const path = join(value.repo, '.git/index.lock');
        const lock = await readFile(path);
        if (divergent)
          value.store.gitCommitOperations.compareAndSwap({
            scope: scope(value, record),
            operationId: record.operationId,
            requestHash: requestDigest,
            expectedRevision: record.revision,
            expectedState: 'ref_updated',
            state: 'recovery_required',
            error: { code: 'TEST_DIVERGENCE' },
          });
        else
          await value.coordinator().transition({
            operationId: record.operationId,
            requestHash: record.requestHash,
            expectedRevision: record.revision,
            state: 'recovery_required',
            recoveryReason: 'TEST_BLOCKED',
          });
        const result = await recoverCommitPlan(value.git, options(value, record.operationId));
        assert.equal(result.state, 'recovery_required');
        assert.deepEqual(await index(value.repo), before);
        assert.deepEqual(await readFile(path), lock);
      }),
    );
});

test('detectable index or lock races immediately before recovery rename do not overwrite them', async (context) => {
  for (const change of ['index', 'lock'] as const)
    await context.test(change, () =>
      fixture(async (value) => {
        const record = await crash(value);
        const path = join(value.repo, '.git/index.lock');
        let changed: Buffer | undefined;
        const result = await recoverCommitPlan(value.git, {
          ...options(value, record.operationId),
          checkpoint: async (phase) => {
            if (phase !== 'before_index_publish') return;
            if (change === 'index') {
              changed = Buffer.concat([await index(value.repo), Buffer.from('raced index')]);
              await writeFile(join(value.repo, '.git/index'), changed);
            } else {
              await unlink(path);
              await writeFile(path, 'foreign lock race');
            }
          },
        });
        assert.equal(result.state, 'recovery_required');
        if (change === 'index') assert.deepEqual(await index(value.repo), changed);
        else {
          assert.deepEqual(await index(value.repo), record.originalIndex.bytes);
          assert.equal(await readFile(path, 'utf8'), 'foreign lock race');
        }
      }),
    );
});

test('a lost completion acknowledgement can be retried without rewriting published index', () =>
  fixture(async (value) => {
    const record = await crash(value);
    const base = value.coordinator();
    const interrupted = await recoverCommitPlan(value.git, {
      ...options(value, record.operationId),
      coordinator: {
        ...base,
        transition: async (input) => {
          const result = await base.transition(input);
          if (input.state === 'completed') throw new Error('lost acknowledgement');
          return result;
        },
      },
    });
    assert.equal(interrupted.state, 'recovery_required');
    const before = await index(value.repo);
    const retry = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(retry.state, 'completed');
    assert.deepEqual(await index(value.repo), before);
  }));

test('admin replacement after observation cannot redirect index publication', () =>
  fixture(async (value) => {
    const record = await crash(value);
    const oldAdmin = join(value.repo, 'saved-admin');
    let oldIndex: Buffer | undefined;
    const result = await recoverCommitPlan(value.git, {
      ...options(value, record.operationId),
      checkpoint: async (phase) => {
        if (phase !== 'before_index_publish') return;
        oldIndex = await index(value.repo);
        await rename(value.git.admin, oldAdmin);
        await cp(oldAdmin, value.git.admin, { recursive: true });
      },
    });
    assert.equal(result.state, 'recovery_required');
    assert.deepEqual(await index(value.repo), oldIndex);
    assert.deepEqual(await readFile(join(oldAdmin, 'index')), oldIndex);
    assert.deepEqual(await readFile(join(oldAdmin, 'index.lock')), record.targetIndex.bytes);
    assert.deepEqual(await readFile(join(value.git.admin, 'index.lock')), record.targetIndex.bytes);
  }));

test('interruption after recovery rename is retryable using receipts alone', () =>
  fixture(async (value) => {
    const record = await crash(value);
    const interrupted = await recoverCommitPlan(value.git, {
      ...options(value, record.operationId),
      checkpoint: async (phase) => {
        if (phase === 'index_published') throw new Error('recovery interrupted');
      },
    });
    assert.equal(interrupted.state, 'recovery_required');
    if (interrupted.state === 'recovery_required')
      assert.equal(interrupted.evidence.indexLock.state, 'absent');
    const published = await index(value.repo);
    assert.deepEqual(published, record.targetIndex.bytes);
    const retry = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(retry.state, 'completed');
    if (retry.state === 'completed') assert.equal(retry.indexPublished, false);
    assert.deepEqual(await index(value.repo), published);
  }));

test('explicit abandon preserves old HEAD, exact original index and worktree, removes only owned lock, and records a non-success terminal state', () =>
  fixture(async (value) => {
    const record = await crash(value, 'prepared');
    const beforeIndex = await index(value.repo);
    const beforeHead = head(value.repo);
    const worktree = await readFile(join(value.repo, 'selected.txt'));
    const phases: string[] = [];
    const result = await abandonCommitPlan(value.git, {
      ...options(value, record.operationId),
      checkpoint: async (phase) => {
        phases.push(phase);
      },
    });
    assert.equal(result.state, 'aborted');
    if (result.state !== 'aborted') return;
    assert.equal(result.lockRemoved, true);
    assert.equal(result.replayed, false);
    assert.equal(Object.hasOwn(result, 'oid'), false);
    assert.equal(Object.hasOwn(result, 'commits'), false);
    assert.equal(head(value.repo), beforeHead);
    assert.deepEqual(await index(value.repo), beforeIndex);
    assert.deepEqual(await readFile(join(value.repo, 'selected.txt')), worktree);
    await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
    assert.deepEqual(phases, ['observed', 'aborting', 'before_lock_remove', 'lock_removed']);
    assert.equal((await value.journal.read(record.operationId))?.state, 'aborted');
    const stored = value.store.gitCommitOperations.get(scope(value, record), record.operationId);
    assert.equal(stored?.state, 'aborted');
    assert.equal(stored?.revision, 3);
    assert.ok(stored?.finishedAt);
    assert.equal(
      (await value.journal.pending()).some((item) => item.operationId === record.operationId),
      false,
    );
    assert.equal(value.store.gitCommitOperations.listUnfinished(scope(value, record)).length, 0);
    const replay = await abandonCommitPlan(value.git, options(value, record.operationId));
    assert.equal(replay.state, 'aborted');
    if (replay.state === 'aborted') {
      assert.equal(replay.replayed, true);
      assert.equal(replay.lockRemoved, false);
    }
    assert.equal(
      (await recoverCommitPlan(value.git, options(value, record.operationId))).state,
      'recovery_required',
    );
    const next = await crash(value, 'prepared');
    assert.notEqual(next.operationId, record.operationId);
  }));

test('real SIGKILL during abandonment remains visible and resumes before or after owned-lock deletion', async (context) => {
  for (const phase of ['aborting', 'lock_removed'] as const)
    await context.test(phase, () =>
      fixture(async (value) => {
        const record = await crash(value, 'prepared');
        const before = await index(value.repo);
        await crashAbandon(value, record, phase);
        assert.equal((await value.journal.read(record.operationId))?.state, 'aborting');
        assert.equal(
          value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.state,
          'aborting',
        );
        assert.equal(
          (await value.journal.pending()).some((item) => item.operationId === record.operationId),
          true,
        );
        assert.equal(
          value.store.gitCommitOperations.listUnfinished(scope(value, record)).length,
          1,
        );
        assert.equal(
          (await recoverCommitPlan(value.git, options(value, record.operationId))).state,
          'recovery_required',
        );
        const result = await abandonCommitPlan(value.git, options(value, record.operationId));
        assert.equal(result.state, 'aborted');
        if (result.state === 'aborted') assert.equal(result.lockRemoved, phase === 'aborting');
        assert.equal(head(value.repo), record.oldHead);
        assert.deepEqual(await index(value.repo), before);
        assert.equal((await value.journal.read(record.operationId))?.state, 'aborted');
        await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
      }),
    );
});

test('abandon never cleans a prepared lock when HEAD, index or lock evidence changed', async (context) => {
  for (const change of ['head', 'index', 'missing', 'replaced', 'content'] as const)
    await context.test(change, () =>
      fixture(async (value) => {
        const record = await crash(value, 'prepared');
        const path = join(value.repo, '.git/index.lock');
        if (change === 'head')
          git(value.repo, ['update-ref', record.ref, record.newHead, record.oldHead ?? '']);
        if (change === 'index')
          await writeFile(
            join(value.repo, '.git/index'),
            Buffer.concat([await index(value.repo), Buffer.from('external index')]),
          );
        if (change === 'missing') await unlink(path);
        if (change === 'replaced') {
          await unlink(path);
          await writeFile(path, 'foreign lock');
        }
        if (change === 'content') await writeFile(path, 'changed lock contents');
        const beforeIndex = await index(value.repo);
        const beforeHead = head(value.repo);
        const beforeLock = await readFile(path).catch(() => null);
        assert.equal(
          (await abandonCommitPlan(value.git, options(value, record.operationId))).state,
          'recovery_required',
        );
        assert.deepEqual(await index(value.repo), beforeIndex);
        assert.equal(head(value.repo), beforeHead);
        assert.deepEqual(await readFile(path).catch(() => null), beforeLock);
        assert.equal((await value.journal.read(record.operationId))?.state, 'prepared');
      }),
    );
});

test('abandon refuses advanced references, completed operations and journal/SQLite divergence', async (context) => {
  for (const phase of [
    'after_ref_before_receipt',
    'ref_updated',
    'index_published',
    'divergent',
  ] as const)
    await context.test(phase, () =>
      fixture(async (value) => {
        const record = await crash(value, phase === 'divergent' ? 'prepared' : phase);
        if (phase === 'index_published')
          assert.equal(
            (await recoverCommitPlan(value.git, options(value, record.operationId))).state,
            'completed',
          );
        if (phase === 'divergent')
          value.store.gitCommitOperations.compareAndSwap({
            scope: scope(value, record),
            operationId: record.operationId,
            requestHash: requestDigest,
            expectedRevision: record.revision,
            expectedState: 'prepared',
            state: 'aborting',
          });
        const before = await index(value.repo);
        const beforeHead = head(value.repo);
        const path = join(value.repo, '.git/index.lock');
        const lock = await readFile(path).catch(() => null);
        assert.equal(
          (await abandonCommitPlan(value.git, options(value, record.operationId))).state,
          'recovery_required',
        );
        assert.equal(head(value.repo), beforeHead);
        assert.deepEqual(await index(value.repo), before);
        assert.deepEqual(await readFile(path).catch(() => null), lock);
      }),
    );
});

test('foreign locks before or after owned-lock deletion remain untouched and keep aborting visible', async (context) => {
  for (const phase of ['before_lock_remove', 'lock_removed'] as const)
    await context.test(phase, () =>
      fixture(async (value) => {
        const record = await crash(value, 'prepared');
        const path = join(value.repo, '.git/index.lock');
        const before = await index(value.repo);
        const result = await abandonCommitPlan(value.git, {
          ...options(value, record.operationId),
          checkpoint: async (current) => {
            if (current !== phase) return;
            if (phase === 'before_lock_remove') await unlink(path);
            await writeFile(path, 'foreign lock during abandonment');
          },
        });
        assert.equal(result.state, 'recovery_required');
        assert.equal(await readFile(path, 'utf8'), 'foreign lock during abandonment');
        assert.deepEqual(await index(value.repo), before);
        assert.equal(head(value.repo), record.oldHead);
        assert.equal((await value.journal.read(record.operationId))?.state, 'aborting');
        assert.equal(
          (await value.journal.pending()).some((item) => item.operationId === record.operationId),
          true,
        );
        assert.equal(
          (await abandonCommitPlan(value.git, options(value, record.operationId))).state,
          'recovery_required',
        );
        assert.equal(await readFile(path, 'utf8'), 'foreign lock during abandonment');
      }),
    );
});

test('lost aborted acknowledgement retries as aborted without reporting a commit', () =>
  fixture(async (value) => {
    const record = await crash(value, 'prepared');
    const base = value.coordinator();
    const result = await abandonCommitPlan(value.git, {
      ...options(value, record.operationId),
      coordinator: {
        ...base,
        transition: async (input) => {
          const next = await base.transition(input);
          if (input.state === 'aborted') throw new Error('lost aborted acknowledgement');
          return next;
        },
      },
    });
    assert.equal(result.state, 'recovery_required');
    assert.equal((await value.journal.read(record.operationId))?.state, 'aborted');
    const retry = await abandonCommitPlan(value.git, options(value, record.operationId));
    assert.equal(retry.state, 'aborted');
    assert.equal(Object.hasOwn(retry, 'oid'), false);
    assert.equal(head(value.repo), record.oldHead);
  }));

test('real SIGKILL after journal transition but before SQLite CAS repairs exactly one legal receipt edge', async (context) => {
  for (const edge of ['ref_updated', 'completed', 'aborting', 'aborted'] as const)
    await context.test(edge, () =>
      fixture(async (value) => {
        const record = await crashAhead(value, edge);
        const authoritative = value.store.gitCommitOperations.get(
          scope(value, record),
          record.operationId,
        );
        assert.ok(authoritative);
        assert.equal(record.state, edge);
        assert.equal(authoritative.revision + 1, record.revision);
        const beforeHead = head(value.repo);
        const beforeIndex = await index(value.repo);
        const base = value.coordinator();
        await assert.rejects(base.read(record.operationId));
        const reconcile = base.reconcileAhead;
        assert.ok(reconcile);
        let repairs = 0;
        const request: CommitPlanRecoveryOptions = {
          ...options(value, record.operationId),
          coordinator: {
            ...base,
            reconcileAhead: async (input) => {
              repairs++;
              return reconcile(input);
            },
          },
        };
        const result =
          edge === 'aborting' || edge === 'aborted'
            ? await abandonCommitPlan(value.git, request)
            : await recoverCommitPlan(value.git, request);
        assert.equal(
          result.state,
          edge === 'aborting' || edge === 'aborted' ? 'aborted' : 'completed',
          JSON.stringify(result),
        );
        assert.equal(repairs, 1);
        assert.equal(head(value.repo), beforeHead);
        assert.equal((await value.journal.read(record.operationId))?.revision, 3);
        const terminal = value.store.gitCommitOperations.get(
          scope(value, record),
          record.operationId,
        );
        assert.equal(terminal?.revision, 3);
        assert.equal(terminal?.state, result.state);
        if (edge === 'aborting' || edge === 'aborted')
          assert.deepEqual(await index(value.repo), beforeIndex);
        else assert.deepEqual(await index(value.repo), record.targetIndex.bytes);
        const again =
          edge === 'aborting' || edge === 'aborted'
            ? await abandonCommitPlan(value.git, request)
            : await recoverCommitPlan(value.git, request);
        assert.equal(again.state, result.state);
        assert.equal(repairs, 1);
      }),
    );
});

test('receipt-ahead repair never advances SQLite when actual HEAD, index or lock evidence differs', async (context) => {
  for (const change of ['head', 'index', 'foreign_lock', 'published_inode'] as const)
    await context.test(change, () =>
      fixture(async (value) => {
        const record = await crashAhead(
          value,
          change === 'published_inode' ? 'completed' : 'ref_updated',
        );
        const path = join(value.repo, '.git/index.lock');
        if (change === 'head')
          git(value.repo, ['update-ref', record.ref, record.oldHead ?? '', record.newHead]);
        if (change === 'index')
          await writeFile(
            join(value.repo, '.git/index'),
            Buffer.concat([await index(value.repo), Buffer.from('external raw index')]),
          );
        if (change === 'foreign_lock') {
          await unlink(path);
          await writeFile(path, 'foreign lock');
        }
        if (change === 'published_inode') {
          const replacement = join(value.git.admin, 'external-index');
          assert.ok(record.targetIndex.bytes);
          await writeFile(replacement, record.targetIndex.bytes);
          await rename(replacement, join(value.git.admin, 'index'));
        }
        const beforeIndex = await index(value.repo);
        const beforeHead = head(value.repo);
        const beforeLock = await readFile(path).catch(() => null);
        const before = value.store.gitCommitOperations.get(
          scope(value, record),
          record.operationId,
        );
        const base = value.coordinator();
        const reconcile = base.reconcileAhead;
        assert.ok(reconcile);
        let repairs = 0;
        const result = await recoverCommitPlan(value.git, {
          ...options(value, record.operationId),
          coordinator: {
            ...base,
            reconcileAhead: async (input) => {
              repairs++;
              return reconcile(input);
            },
          },
        });
        assert.equal(result.state, 'recovery_required');
        assert.equal(repairs, 0);
        assert.deepEqual(
          value.store.gitCommitOperations.get(scope(value, record), record.operationId),
          before,
        );
        assert.equal(head(value.repo), beforeHead);
        assert.deepEqual(await index(value.repo), beforeIndex);
        assert.deepEqual(await readFile(path).catch(() => null), beforeLock);
      }),
    );
});

test('two missing SQLite receipt edges are never guessed or automatically replayed', () =>
  fixture(async (value) => {
    const record = await crash(value, 'prepared');
    git(value.repo, ['update-ref', record.ref, record.newHead, record.oldHead ?? '']);
    await rename(join(value.git.admin, 'index.lock'), join(value.git.admin, 'index'));
    const advanced = await value.journal.transition({
      operationId: record.operationId,
      requestHash: record.requestHash,
      expectedRevision: 1,
      state: 'ref_updated',
    });
    await value.journal.transition({
      operationId: record.operationId,
      requestHash: record.requestHash,
      expectedRevision: advanced.revision,
      state: 'completed',
    });
    const beforeIndex = await index(value.repo);
    const result = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(result.state, 'recovery_required');
    assert.deepEqual(await index(value.repo), beforeIndex);
    assert.equal(
      value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.revision,
      1,
    );
  }));

test('receipt-ahead inspection must match every frozen journal field before any repair', () =>
  fixture(async (value) => {
    const record = await crashAhead(value, 'ref_updated');
    const base = value.coordinator();
    const inspect = base.readAllowAhead;
    assert.ok(inspect);
    let repairs = 0;
    const result = await recoverCommitPlan(value.git, {
      ...options(value, record.operationId),
      coordinator: {
        ...base,
        readAllowAhead: async (id) => {
          const candidate = await inspect(id);
          assert.ok(candidate);
          return { ...candidate, operation: { ...candidate.operation, commits: ['1'.repeat(40)] } };
        },
        reconcileAhead: async () => {
          repairs++;
          throw new Error('must not repair different frozen evidence');
        },
      },
    });
    assert.equal(result.state, 'recovery_required');
    assert.equal(repairs, 0);
    assert.equal(
      value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.revision,
      1,
    );
  }));

test('recovery rejects changed or removed project/request ownership before any receipt repair or index publication', async (context) => {
  for (const field of ['projectId', 'requestDigest', 'missing'] as const)
    await context.test(field, () =>
      fixture(async (value) => {
        const record = await crashAhead(value, 'ref_updated');
        assert.ok(record.owner);
        const beforeIndex = await index(value.repo);
        const beforeLock = await readFile(join(value.git.admin, 'index.lock'));
        const base = value.coordinator();
        const inspect = base.readAllowAhead;
        assert.ok(inspect);
        let repairs = 0;
        const result = await recoverCommitPlan(value.git, {
          ...options(value, record.operationId),
          coordinator: {
            ...base,
            readAllowAhead: async (id) => {
              const candidate = await inspect(id);
              assert.ok(candidate?.operation.owner);
              const owner =
                field === 'missing'
                  ? undefined
                  : {
                      ...candidate.operation.owner,
                      ...(field === 'projectId'
                        ? { projectId: randomUUID() }
                        : { requestDigest: 'b'.repeat(64) }),
                    };
              return { ...candidate, operation: { ...candidate.operation, owner } };
            },
            reconcileAhead: async () => {
              repairs++;
              throw new Error('must not repair changed ownership');
            },
          },
        });
        assert.equal(result.state, 'recovery_required');
        if (result.state === 'recovery_required')
          assert.equal(result.reason, 'GIT_PLAN_RECOVERY_STATE_MISMATCH');
        assert.equal(repairs, 0);
        assert.equal(
          value.store.gitCommitOperations.get(scope(value, record), record.operationId)?.revision,
          1,
        );
        assert.deepEqual(await index(value.repo), beforeIndex);
        assert.deepEqual(await readFile(join(value.git.admin, 'index.lock')), beforeLock);
        assert.deepEqual((await value.journal.read(record.operationId))?.owner, record.owner);
      }),
    );
});

test('late worktree edits remain untouched and unstaged through index recovery', () =>
  fixture(async (value) => {
    const record = await crash(value);
    await writeFile(join(value.repo, 'selected.txt'), 'user edit after crash\n');
    const result = await recoverCommitPlan(value.git, options(value, record.operationId));
    assert.equal(result.state, 'completed');
    assert.equal(
      await readFile(join(value.repo, 'selected.txt'), 'utf8'),
      'user edit after crash\n',
    );
    assert.equal(git(value.repo, ['show', ':selected.txt']), 'workspace\n');
    assert.equal(git(value.repo, ['diff', '--name-only']), 'selected.txt\n');
  }));
