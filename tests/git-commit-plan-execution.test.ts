/**
 * @file 验证冻结多提交执行器的真实 Git 行为与故障恢复边界。
 * @implementation 仅在独立临时仓库造链和注入竞态，核对索引保全、引用 CAS、持久日志、锁归属与重复请求。
 * @updated 2026-11-24T18:00:00+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CommitJournal } from '../server/modules/git/commit-journal.js';
import { compileCommitPlan } from '../server/modules/git/commit-plan-compiler.js';
import {
  executeCommitPlan,
  type CommitPlanExecutionCheckpoint,
  type CommitPlanExecutionCoordinator,
} from '../server/modules/git/commit-plan-execution.js';
import {
  readCommitPlanSnapshot,
  type GitCommitPlanSnapshot,
} from '../server/modules/git/commit-plan-snapshot.js';
import { LocalGit } from '../server/modules/git/git-cli.js';

// This helper is exclusively called with fixture paths created by mkdtemp below.
const command = (repo: string, args: string[], input?: Buffer | string) =>
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
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: devNull,
        LANG: 'C',
        LC_ALL: 'C',
      },
    },
  );

interface Fixture {
  repo: string;
  data: string;
  git: LocalGit;
  journal: CommitJournal;
  coordinator: CommitPlanExecutionCoordinator;
}
async function fixture(
  work: (value: Fixture) => Promise<void>,
  unborn = false,
  format: 'sha1' | 'sha256' = 'sha1',
) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-multi-execution-test-'));
  const repo = join(base, 'repo');
  const data = join(base, 'data');
  await mkdir(repo);
  await mkdir(data, { mode: 0o700 });
  command(repo, ['init', '--object-format=' + format, '-b', 'main']);
  command(repo, ['config', 'user.name', 'Execution fixture']);
  command(repo, ['config', 'user.email', 'execution@example.test']);
  command(repo, ['config', 'commit.gpgSign', 'false']);
  if (!unborn) {
    for (const path of ['selected.txt', 'keep.txt', 'other.txt'])
      await writeFile(join(repo, path), 'base\n');
    command(repo, ['add', '.']);
    command(repo, ['commit', '-m', 'initial']);
  }
  const journal = new CommitJournal(data);
  // Integration stand-in: production injects a coordinator that also owns the SQLite operation CAS.
  const coordinator: CommitPlanExecutionCoordinator = {
    read: (id) => journal.read(id),
    unfinished: () => journal.pending(),
    prepare: (input) => journal.prepare(input),
    transition: (input) => journal.transition(input),
  };
  try {
    await work({ repo, data, git: await LocalGit.open(repo), journal, coordinator });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
async function ordinary(value: Fixture) {
  await writeFile(join(value.repo, 'selected.txt'), 'selected staged\n');
  command(value.repo, ['add', 'selected.txt']);
  await writeFile(join(value.repo, 'selected.txt'), 'selected workspace\n');
  await writeFile(join(value.repo, 'keep.txt'), 'keep staged\n');
  command(value.repo, ['add', 'keep.txt']);
  const snapshot = await readCommitPlanSnapshot(value.git);
  const selected = snapshot.units.filter((unit) => unit.path === 'selected.txt');
  const compilation = compileCommitPlan(snapshot, {
    groups: selected.map((unit, i) => ({
      title: 'Group ' + (i + 1),
      body: 'Verified body',
      unitIds: [unit.id],
    })),
    excludedUnitIds: snapshot.units
      .filter((unit) => unit.path !== 'selected.txt')
      .map((unit) => unit.id),
  });
  return { snapshot, compilation };
}
const index = (repo: string) => readFile(join(repo, '.git/index'));
const head = (repo: string) => command(repo, ['rev-parse', 'HEAD']).trim();
function compileAll(snapshot: GitCommitPlanSnapshot) {
  return compileCommitPlan(snapshot, {
    groups: snapshot.units.map((unit, i) => ({
      title: 'Commit ' + i,
      body: '',
      unitIds: [unit.id],
    })),
    excludedUnitIds: [],
  });
}

test('real Git ordered chain preserves excluded staged content and consumes selected unstaged without reverse staging', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const initialHead = head(value.repo);
    const operationId = randomUUID();
    const phases: CommitPlanExecutionCheckpoint[] = [];
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId,
      coordinator: value.coordinator,
      checkpoint: async (phase) => {
        phases.push(phase);
      },
    });
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed') return;
    assert.equal(result.commits.length, 2);
    const [first, second] = result.commits;
    assert.ok(first && second);
    assert.equal(command(value.repo, ['rev-parse', first + '^']).trim(), initialHead);
    assert.equal(command(value.repo, ['rev-parse', second + '^']).trim(), first);
    assert.equal(command(value.repo, ['show', first + ':selected.txt']), 'selected staged\n');
    assert.equal(command(value.repo, ['show', second + ':selected.txt']), 'selected workspace\n');
    assert.equal(command(value.repo, ['show', second + ':keep.txt']), 'base\n');
    assert.equal(command(value.repo, ['show', ':selected.txt']), 'selected workspace\n');
    assert.equal(command(value.repo, ['show', ':keep.txt']), 'keep staged\n');
    assert.equal(command(value.repo, ['diff', '--cached', '--name-only']), 'keep.txt\n');
    assert.equal(command(value.repo, ['diff', '--name-only']), '');
    assert.equal(await readFile(join(value.repo, 'selected.txt'), 'utf8'), 'selected workspace\n');
    assert.equal((await value.journal.read(operationId))?.state, 'completed');
    assert.deepEqual(phases, [
      'locked',
      'objects_written',
      'prepared',
      'before_ref_update',
      'ref_updated',
      'before_index_publish',
      'index_published',
    ]);
    await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
    const replay = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId,
      coordinator: value.coordinator,
    });
    assert.equal(replay.state, 'completed');
    if (replay.state === 'completed') assert.equal(replay.replayed, true);
    assert.equal(command(value.repo, ['rev-list', '--count', 'HEAD']).trim(), '3');
  }));

test('unborn HEAD creates root and descendant commits from exact bytes and modes without touching worktree', () =>
  fixture(async (value) => {
    await writeFile(join(value.repo, 'a.txt'), Buffer.from([0, 1, 255, 10]));
    await writeFile(join(value.repo, 'run.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(value.repo, 'run.sh'), 0o755);
    const snapshot = await readCommitPlanSnapshot(value.git);
    assert.equal(snapshot.target.head, null);
    assert.equal(snapshot.index.fingerprint, null);
    const result = await executeCommitPlan(value.git, snapshot, compileAll(snapshot), {
      operationId: randomUUID(),
      coordinator: value.coordinator,
    });
    assert.equal(result.state, 'completed');
    if (result.state !== 'completed') return;
    assert.equal(command(value.repo, ['rev-list', '--count', 'HEAD']).trim(), '2');
    assert.equal(
      command(value.repo, [
        'rev-list',
        '--parents',
        '--max-count=1',
        result.commits[0] ?? '',
      ]).trim(),
      result.commits[0],
    );
    assert.match(command(value.repo, ['ls-files', '--stage', 'run.sh']), /^100755 /u);
    assert.equal(command(value.repo, ['status', '--porcelain']), '');
    assert.deepEqual(await readFile(join(value.repo, 'a.txt')), Buffer.from([0, 1, 255, 10]));
  }, true));

test('worktree, HEAD, and raw index staleness fail before any reference publication', async (context) => {
  for (const change of ['worktree', 'head', 'index'] as const)
    await context.test(change, () =>
      fixture(async (value) => {
        const { snapshot, compilation } = await ordinary(value);
        if (change === 'worktree')
          await writeFile(join(value.repo, 'selected.txt'), 'external edit\n');
        if (change === 'head') command(value.repo, ['commit', '--allow-empty', '-m', 'external']);
        if (change === 'index') {
          await writeFile(join(value.repo, 'other.txt'), 'external index\n');
          command(value.repo, ['add', 'other.txt']);
        }
        const before = head(value.repo);
        const beforeIndex = await index(value.repo);
        await assert.rejects(
          executeCommitPlan(value.git, snapshot, compilation, {
            operationId: randomUUID(),
            coordinator: value.coordinator,
          }),
          { code: 'GIT_PLAN_STALE' },
        );
        assert.equal(head(value.repo), before);
        assert.deepEqual(await index(value.repo), beforeIndex);
        await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
      }),
    );
});

test('foreign index locks are never deleted, including replacement of an acquired lock', async (context) => {
  for (const replace of [false, true])
    await context.test(String(replace), () =>
      fixture(async (value) => {
        const { snapshot, compilation } = await ordinary(value);
        const path = join(value.repo, '.git/index.lock');
        if (!replace) await writeFile(path, 'foreign lock');
        await assert.rejects(
          executeCommitPlan(value.git, snapshot, compilation, {
            operationId: randomUUID(),
            coordinator: value.coordinator,
            checkpoint: async (phase) => {
              if (replace && phase === 'locked') {
                await unlink(path);
                await writeFile(path, 'foreign lock');
              }
            },
          }),
        );
        assert.equal(await readFile(path, 'utf8'), 'foreign lock');
        assert.equal(head(value.repo), snapshot.target.head);
      }),
    );
});

test('detected external index writes before and after reference CAS preserve external bytes and durable recovery evidence', async (context) => {
  for (const phase of ['before_ref_update', 'before_index_publish'] as const)
    await context.test(phase, () =>
      fixture(async (value) => {
        const { snapshot, compilation } = await ordinary(value);
        const operationId = randomUUID();
        let external: Buffer | undefined;
        const result = await executeCommitPlan(value.git, snapshot, compilation, {
          operationId,
          coordinator: value.coordinator,
          checkpoint: async (current) => {
            if (current === phase) {
              external = Buffer.concat([await index(value.repo), Buffer.from('external write')]);
              await writeFile(join(value.repo, '.git/index'), external);
            }
          },
        });
        assert.equal(result.state, 'recovery_required');
        assert.deepEqual(await index(value.repo), external);
        const record = await value.journal.read(operationId);
        assert.equal(record?.state, 'recovery_required');
        assert.ok(record?.originalIndex.bytes && record.targetIndex.bytes);
        if (result.state === 'recovery_required') {
          assert.equal(result.evidence.indexLock?.retained, true);
          assert.equal(
            head(value.repo),
            phase === 'before_ref_update' ? snapshot.target.head : result.evidence.newHead,
          );
        }
        assert.ok((await lstat(join(value.repo, '.git/index.lock'))).isFile());
        const retry = await executeCommitPlan(value.git, snapshot, compilation, {
          operationId,
          coordinator: value.coordinator,
        });
        assert.equal(retry.state, 'recovery_required');
      }),
    );
});

test('forced interruption after reference publication keeps original index and refuses replay', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const original = await index(value.repo);
    const operationId = randomUUID();
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId,
      coordinator: value.coordinator,
      checkpoint: async (phase) => {
        if (phase === 'ref_updated') throw new Error('injected interruption');
      },
    });
    assert.equal(result.state, 'recovery_required');
    assert.deepEqual(await index(value.repo), original);
    assert.notEqual(head(value.repo), snapshot.target.head);
    assert.equal((await value.journal.read(operationId))?.state, 'recovery_required');
    assert.equal(
      (
        await executeCommitPlan(value.git, snapshot, compilation, {
          operationId,
          coordinator: value.coordinator,
        })
      ).state,
      'recovery_required',
    );
  }));

test('reference CAS rejects a racing external update without publishing the target index', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const original = await index(value.repo);
    const external = command(value.repo, [
      'commit-tree',
      snapshot.target.tree ?? '',
      '-p',
      snapshot.target.head ?? '',
      '-m',
      'external',
    ]).trim();
    const run = value.git.run.bind(value.git);
    value.git.run = (args, options) => {
      if (args.includes('update-ref'))
        command(value.repo, [
          'update-ref',
          snapshot.target.ref,
          external,
          snapshot.target.head ?? '',
        ]);
      return run(args, options);
    };
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId: randomUUID(),
      coordinator: value.coordinator,
    });
    assert.equal(result.state, 'recovery_required');
    assert.equal(head(value.repo), external);
    assert.deepEqual(await index(value.repo), original);
  }));

test('post-CAS worktree changes block index publication and preserve user edits', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const original = await index(value.repo);
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId: randomUUID(),
      coordinator: value.coordinator,
      checkpoint: async (phase) => {
        if (phase === 'before_index_publish')
          await writeFile(join(value.repo, 'selected.txt'), 'external late edit\n');
      },
    });
    assert.equal(result.state, 'recovery_required');
    assert.equal(await readFile(join(value.repo, 'selected.txt'), 'utf8'), 'external late edit\n');
    assert.deepEqual(await index(value.repo), original);
  }));

test('required signing, missing identity, and tampered compiled bytes fail closed', async (context) => {
  for (const kind of ['signing', 'identity', 'tampered'] as const)
    await context.test(kind, () =>
      fixture(async (value) => {
        const { snapshot, compilation } = await ordinary(value);
        if (kind === 'signing') command(value.repo, ['config', 'commit.gpgSign', 'true']);
        if (kind === 'identity') command(value.repo, ['config', 'user.email', '']);
        const candidate =
          kind === 'tampered'
            ? { ...compilation, finalIndex: { ...compilation.finalIndex, files: [] } }
            : compilation;
        const before = head(value.repo);
        const original = await index(value.repo);
        await assert.rejects(
          executeCommitPlan(value.git, snapshot, candidate, {
            operationId: randomUUID(),
            coordinator: value.coordinator,
          }),
        );
        assert.equal(head(value.repo), before);
        assert.deepEqual(await index(value.repo), original);
        await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
      }),
    );
});

test('ambiguous prepare failure never updates references and retains persisted backups', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const operationId = randomUUID();
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId,
      coordinator: {
        ...value.coordinator,
        prepare: async (input) => {
          await value.coordinator.prepare(input);
          throw new Error('lost acknowledgement');
        },
      },
    });
    assert.equal(result.state, 'recovery_required');
    assert.equal(head(value.repo), snapshot.target.head);
    assert.equal((await value.journal.read(operationId))?.state, 'recovery_required');
  }));

test('real process SIGKILL between reference and index publication leaves durable evidence and blocks replay', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const original = await index(value.repo);
    const operationId = randomUUID();
    const imports = (name: string) =>
      new URL('../server/modules/git/' + name + '.ts', import.meta.url).href;
    const script = `
    import {LocalGit} from ${JSON.stringify(imports('git-cli'))};
    import {CommitJournal} from ${JSON.stringify(imports('commit-journal'))};
    import {executeCommitPlan} from ${JSON.stringify(imports('commit-plan-execution'))};
    const [repo,data,operationId,snapshot,compilation] = process.argv.slice(1);
    const journal = new CommitJournal(data);
    const coordinator = {read:id=>journal.read(id),unfinished:()=>journal.pending(),prepare:i=>journal.prepare(i),transition:i=>journal.transition(i)};
    await executeCommitPlan(await LocalGit.open(repo),JSON.parse(snapshot),JSON.parse(compilation),{
      operationId,coordinator,checkpoint:async phase=>{if(phase==='ref_updated') process.kill(process.pid,'SIGKILL')}
    });
  `;
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
        operationId,
        JSON.stringify(snapshot),
        JSON.stringify(compilation),
      ],
      {
        cwd: new URL('../', import.meta.url),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const persisted = await value.journal.read(operationId);
    assert.equal(persisted?.state, 'ref_updated');
    const retainedLock = await lstat(join(value.repo, '.git/index.lock'), { bigint: true });
    const lockIdentity = retainedLock.dev + ':' + retainedLock.ino;
    assert.equal(persisted?.indexLockIdentity, lockIdentity);
    const observation = {
      repositoryId: snapshot.repositoryId,
      worktreeIdentity: snapshot.rootIdentity,
      adminIdentity: snapshot.adminIdentity,
      ref: snapshot.target.ref,
      head: head(value.repo),
      indexHash: snapshot.index.fingerprint,
      indexLock: { state: 'owned', operationId, identity: lockIdentity },
    };
    assert.equal(
      (await value.journal.reconcile(operationId, observation)).decision,
      'publish_index',
    );
    assert.equal(
      (
        await value.journal.reconcile(operationId, {
          ...observation,
          indexLock: { ...observation.indexLock, identity: '0:1' },
        })
      ).decision,
      'recovery_required',
    );
    assert.equal(head(value.repo), persisted?.newHead);
    assert.deepEqual(await index(value.repo), original);
    assert.deepEqual(
      await readFile(join(value.repo, '.git/index.lock')),
      persisted?.targetIndex.bytes,
    );
    const retry = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId,
      coordinator: value.coordinator,
    });
    assert.equal(retry.state, 'recovery_required');
    assert.equal(command(value.repo, ['rev-list', '--count', 'HEAD']).trim(), '3');
  }));

test('one staged hunk commits while another staged hunk in the same file remains staged', () =>
  fixture(async (value) => {
    const lines = Array.from({ length: 40 }, (_, i) => 'line ' + i + '\n');
    await writeFile(join(value.repo, 'selected.txt'), lines.join(''));
    command(value.repo, ['add', 'selected.txt']);
    command(value.repo, ['commit', '-m', 'long baseline']);
    lines[1] = 'first selected edit\n';
    lines[35] = 'second excluded edit\n';
    await writeFile(join(value.repo, 'selected.txt'), lines.join(''));
    command(value.repo, ['add', 'selected.txt']);
    const snapshot = await readCommitPlanSnapshot(value.git);
    assert.equal(snapshot.units.length, 2);
    const first = snapshot.units[0];
    const second = snapshot.units[1];
    assert.ok(first && second);
    const compilation = compileCommitPlan(snapshot, {
      groups: [{ title: 'First hunk', body: '', unitIds: [first.id] }],
      excludedUnitIds: [second.id],
    });
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId: randomUUID(),
      coordinator: value.coordinator,
    });
    assert.equal(result.state, 'completed');
    const committed = command(value.repo, ['show', 'HEAD:selected.txt']);
    assert.match(committed, /first selected edit/u);
    assert.doesNotMatch(committed, /second excluded edit/u);
    const remaining = command(value.repo, ['diff', '--cached']);
    assert.doesNotMatch(remaining, /first selected edit/u);
    assert.match(remaining, /second excluded edit/u);
    assert.equal(command(value.repo, ['diff']), '');
  }));

test('selected unstaged deletion and mode changes publish exact index states', async (context) => {
  for (const action of ['deletion', 'mode'] as const)
    await context.test(action, () =>
      fixture(async (value) => {
        if (action === 'deletion') await unlink(join(value.repo, 'selected.txt'));
        else await chmod(join(value.repo, 'selected.txt'), 0o755);
        const snapshot = await readCommitPlanSnapshot(value.git);
        const result = await executeCommitPlan(value.git, snapshot, compileAll(snapshot), {
          operationId: randomUUID(),
          coordinator: value.coordinator,
        });
        assert.equal(result.state, 'completed');
        assert.equal(command(value.repo, ['status', '--porcelain']), '');
        if (action === 'mode')
          assert.match(command(value.repo, ['ls-files', '--stage', 'selected.txt']), /^100755 /u);
        else assert.equal(command(value.repo, ['ls-files', 'selected.txt']), '');
      }),
    );
});

test('SHA-256 repositories use the correct object and reference widths', () =>
  fixture(
    async (value) => {
      const { snapshot, compilation } = await ordinary(value);
      const result = await executeCommitPlan(value.git, snapshot, compilation, {
        operationId: randomUUID(),
        coordinator: value.coordinator,
      });
      assert.equal(result.state, 'completed');
      if (result.state === 'completed') assert.ok(result.commits.every((oid) => oid.length === 64));
      assert.equal(command(value.repo, ['diff', '--cached', '--name-only']), 'keep.txt\n');
    },
    false,
    'sha256',
  ));

test('detached HEAD and split indexes fail closed before any publication', async (context) => {
  for (const kind of ['detached', 'split'] as const)
    await context.test(kind, () =>
      fixture(async (value) => {
        await writeFile(join(value.repo, 'selected.txt'), 'selected\n');
        command(value.repo, ['add', 'selected.txt']);
        if (kind === 'detached') command(value.repo, ['checkout', '--detach']);
        else command(value.repo, ['update-index', '--split-index']);
        const snapshot = await readCommitPlanSnapshot(value.git);
        const before = head(value.repo);
        const beforeIndex = await index(value.repo);
        await assert.rejects(
          executeCommitPlan(value.git, snapshot, compileAll(snapshot), {
            operationId: randomUUID(),
            coordinator: value.coordinator,
          }),
          { code: kind === 'detached' ? 'GIT_PLAN_DETACHED_HEAD' : 'GIT_PLAN_INDEX_UNSUPPORTED' },
        );
        assert.equal(head(value.repo), before);
        assert.deepEqual(await index(value.repo), beforeIndex);
        await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
      }),
    );
});

test('a foreign lock substituted after reference update is preserved and never published', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const beforeIndex = await index(value.repo);
    const path = join(value.repo, '.git/index.lock');
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId: randomUUID(),
      coordinator: value.coordinator,
      checkpoint: async (phase) => {
        if (phase === 'before_index_publish') {
          await unlink(path);
          await writeFile(path, 'foreign lock');
        }
      },
    });
    assert.equal(result.state, 'recovery_required');
    if (result.state === 'recovery_required') {
      assert.equal(result.reason, 'GIT_PLAN_LOCK_LOST');
      assert.equal(result.evidence.indexLock?.retained, false);
    }
    assert.equal(await readFile(path, 'utf8'), 'foreign lock');
    assert.deepEqual(await index(value.repo), beforeIndex);
  }));

test('failure after index publication reports recovery evidence without reverting published state', () =>
  fixture(async (value) => {
    const { snapshot, compilation } = await ordinary(value);
    const operationId = randomUUID();
    const result = await executeCommitPlan(value.git, snapshot, compilation, {
      operationId,
      coordinator: value.coordinator,
      checkpoint: async (phase) => {
        if (phase === 'index_published') throw new Error('completion interrupted');
      },
    });
    assert.equal(result.state, 'recovery_required');
    assert.equal(command(value.repo, ['diff', '--cached', '--name-only']), 'keep.txt\n');
    if (result.state === 'recovery_required')
      assert.equal(result.evidence.indexLock?.retained, false);
    assert.equal((await value.journal.read(operationId))?.state, 'recovery_required');
    await assert.rejects(lstat(join(value.repo, '.git/index.lock')), { code: 'ENOENT' });
  }));
