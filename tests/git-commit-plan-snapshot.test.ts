/**
 * @file 验证 AI 多提交候选快照的三态、稳定单元、读取保护及不可变性。
 * @implementation 仅在新建临时仓库写 Git，使用真实对象和索引核对树、补丁、特殊状态与竞态。
 * @updated 2026-11-24T14:50:51+08:00
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyPatch } from 'diff';
import { AppError } from '../shared/types.js';
import { MAX_TEXT } from '../server/files.js';
import { LocalGit } from '../server/modules/git/git-cli.js';
import {
  gitCommitPlanSnapshotSchema,
  readCommitPlanSnapshot,
  type GitCommitPlanFileState,
  type GitCommitPlanSnapshot,
  type GitCommitPlanUnit,
} from '../server/modules/git/commit-plan-snapshot.js';

// Every writing command is rooted in this fixture's mkdtemp, never in the source repository.
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
async function fixture(
  work: (repo: string, local: LocalGit, base: string) => Promise<void>,
  format: 'sha1' | 'sha256' = 'sha1',
  initial = true,
) {
  const base = await mkdtemp(join(tmpdir(), 'atelier-plan-test-'));
  const repo = join(base, 'repo');
  await mkdir(repo);
  try {
    git(repo, 'init', '-b', 'main', '--object-format=' + format);
    git(repo, 'config', 'user.name', 'Snapshot fixture');
    git(repo, 'config', 'user.email', 'snapshot@example.test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    if (initial) {
      await writeFile(join(repo, 'same.txt'), 'A\n');
      await writeFile(join(repo, '.gitignore'), 'ignored/\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'initial');
    }
    await work(repo, await LocalGit.open(repo), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}
function file(snapshot: GitCommitPlanSnapshot, path: string) {
  const result = snapshot.files.find((entry) => entry.path === path);
  assert.ok(result, path + ' must remain visible');
  return result;
}
function text(state: GitCommitPlanFileState) {
  assert.equal(state.kind, 'file');
  if (state.kind !== 'file') throw new Error('Expected captured file');
  assert.equal(state.encoding, 'utf8');
  return state.content;
}
function patch(source: string, units: GitCommitPlanUnit[]) {
  const hunks = units.map((unit) => {
    assert.ok(unit.hunk);
    return unit.hunk;
  });
  return applyPatch(
    source,
    { oldFileName: 'file', newFileName: 'file', oldHeader: undefined, newHeader: undefined, hunks },
    { fuzzFactor: 0, autoConvertLineEndings: false },
  );
}
async function objectFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      result.push(
        ...(await objectFiles(join(directory, entry.name))).map((name) => entry.name + '/' + name),
      );
    else result.push(entry.name);
  }
  return result.sort();
}

test('snapshot preserves A=HEAD, B=index, C=worktree with reproducible executable hunks and no writes', () =>
  fixture(async (repo, local) => {
    await writeFile(join(repo, 'same.txt'), 'B\n');
    git(repo, 'add', 'same.txt');
    await writeFile(join(repo, 'same.txt'), 'C\n');
    const expectedTree = git(repo, 'write-tree').trim(); // Oracle writes only in this test repository.
    const beforeIndex = await readFile(join(repo, '.git/index'));
    const beforeStat = await stat(join(repo, '.git/index'), { bigint: true });
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const references = git(repo, 'show-ref');
    const objects = await objectFiles(join(repo, '.git/objects'));
    const calls: string[][] = [];
    const run = local.run.bind(local);
    local.run = (args, options) => {
      calls.push([...args]);
      return run(args, options);
    };
    const snapshot = await readCommitPlanSnapshot(local);
    assert.deepEqual(
      gitCommitPlanSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))),
      snapshot,
    );
    const item = file(snapshot, 'same.txt');
    assert.equal(text(item.head), 'A\n');
    assert.equal(text(item.index), 'B\n');
    assert.equal(text(item.worktree), 'C\n');
    assert.equal(snapshot.target.head, head);
    assert.equal(snapshot.target.ref, 'refs/heads/main');
    assert.equal(snapshot.index.tree, expectedTree);
    const staged = snapshot.units.filter((unit) => unit.layer === 'staged');
    const unstaged = snapshot.units.filter((unit) => unit.layer === 'unstaged');
    assert.equal(staged.length, 1);
    assert.equal(unstaged.length, 1);
    assert.equal(patch('A\n', staged), 'B\n');
    assert.equal(patch('B\n', unstaged), 'C\n');
    assert.deepEqual(
      unstaged[0]?.dependsOn,
      staged.map((unit) => unit.id),
    );
    assert.deepEqual(await readCommitPlanSnapshot(local), snapshot);
    assert.deepEqual(await readFile(join(repo, '.git/index')), beforeIndex);
    assert.equal(
      (await stat(join(repo, '.git/index'), { bigint: true })).mtimeNs,
      beforeStat.mtimeNs,
    );
    assert.equal(git(repo, 'show-ref'), references);
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head);
    assert.equal(await readFile(join(repo, 'same.txt'), 'utf8'), 'C\n');
    assert.deepEqual(await objectFiles(join(repo, '.git/objects')), objects);
    assert.ok(
      calls.every((args) =>
        [
          'rev-parse',
          'symbolic-ref',
          'status',
          'ls-files',
          'ls-tree',
          'config',
          'cat-file',
          'check-attr',
        ].includes(args[0] ?? ''),
      ),
    );
  }));

test('separated text hunks are independently usable and all workspace hunks depend on staged hunks', () =>
  fixture(async (repo, local) => {
    const a = Array.from({ length: 50 }, (_, i) => 'line ' + i + '\n');
    await writeFile(join(repo, 'same.txt'), a.join(''));
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'long base');
    const b = [...a];
    b[2] = 'staged first\n';
    b[35] = 'staged second\n';
    await writeFile(join(repo, 'same.txt'), b.join(''));
    git(repo, 'add', '.');
    const c = [...b];
    c[8] = 'workspace first\n';
    c[45] = 'workspace second\n';
    await writeFile(join(repo, 'same.txt'), c.join(''));
    const snapshot = await readCommitPlanSnapshot(local);
    const staged = snapshot.units.filter((unit) => unit.layer === 'staged');
    const unstaged = snapshot.units.filter((unit) => unit.layer === 'unstaged');
    assert.equal(staged.length, 2);
    assert.equal(unstaged.length, 2);
    assert.equal(patch(a.join(''), staged), b.join(''));
    assert.equal(patch(b.join(''), unstaged), c.join(''));
    for (const unit of staged) {
      const partial = patch(a.join(''), [unit]);
      assert.equal(typeof partial, 'string');
      assert.notEqual(partial, a.join(''));
      assert.notEqual(partial, b.join(''));
    }
    for (const unit of unstaged)
      assert.deepEqual(
        unit.dependsOn,
        staged.map((entry) => entry.id),
      );
  }));

test('untracked unusual paths and empty files are whole additions; ignored paths remain explicit', () =>
  fixture(async (repo, local) => {
    const names = [':literal\tname\n.txt', 'empty.txt', 'sub/new.txt'];
    await mkdir(join(repo, 'sub'));
    await mkdir(join(repo, 'ignored'));
    for (const name of names)
      await writeFile(join(repo, name), name === 'empty.txt' ? '' : 'new\n');
    await writeFile(join(repo, 'ignored/private'), 'ignored bytes');
    const snapshot = await readCommitPlanSnapshot(local);
    assert.deepEqual(snapshot.ignored, ['ignored']);
    for (const name of names) {
      const item = file(snapshot, name);
      assert.equal(item.head.kind, 'missing');
      assert.equal(item.index.kind, 'missing');
      assert.equal(text(item.worktree), name === 'empty.txt' ? '' : 'new\n');
      const unit = snapshot.units.find((unit) => unit.path === name);
      assert.equal(unit?.layer, 'untracked');
      assert.equal(unit?.kind, 'atomic');
      assert.equal(unit?.reason, 'addition');
    }
    assert.equal(snapshot.files.length, names.length);
  }));

test('renames, binary content, mode-only changes, and no-newline text retain exact bytes and modes', () =>
  fixture(async (repo, local) => {
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(repo, 'mode.sh'), 'echo ok\n');
    await chmod(join(repo, 'mode.sh'), 0o644);
    await writeFile(join(repo, 'no-newline.txt'), 'old');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'special bases');
    await rename(join(repo, 'same.txt'), join(repo, 'renamed.txt'));
    git(repo, 'add', '-A');
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 3, 255]));
    await chmod(join(repo, 'mode.sh'), 0o755);
    await writeFile(join(repo, 'no-newline.txt'), 'new');
    const snapshot = await readCommitPlanSnapshot(local);
    const renamed = file(snapshot, 'renamed.txt');
    assert.equal(renamed.previousPath, 'same.txt');
    assert.equal(text(renamed.head), 'A\n');
    assert.equal(snapshot.units.find((unit) => unit.path === 'renamed.txt')?.reason, 'rename');
    const binary = file(snapshot, 'binary.bin').worktree;
    assert.equal(binary.kind, 'file');
    if (binary.kind === 'file') {
      assert.equal(binary.encoding, 'base64');
      assert.deepEqual(Buffer.from(binary.content, 'base64'), Buffer.from([0, 3, 255]));
    }
    assert.equal(snapshot.units.find((unit) => unit.path === 'binary.bin')?.reason, 'binary');
    assert.equal(snapshot.units.find((unit) => unit.path === 'mode.sh')?.reason, 'modeChange');
    const modeState = file(snapshot, 'mode.sh').worktree;
    assert.equal(modeState.kind === 'file' && modeState.mode, '100755');
    const noNewline = snapshot.units.filter((unit) => unit.path === 'no-newline.txt');
    assert.equal(patch('old', noNewline), 'new');
  }));

test('staged deletion followed by recreation preserves both candidates and dependency', () =>
  fixture(async (repo, local) => {
    git(repo, 'rm', 'same.txt');
    await writeFile(join(repo, 'same.txt'), 'recreated\n');
    const snapshot = await readCommitPlanSnapshot(local);
    const item = file(snapshot, 'same.txt');
    assert.equal(item.statuses.length, 2);
    assert.equal(text(item.head), 'A\n');
    assert.equal(item.index.kind, 'missing');
    assert.equal(text(item.worktree), 'recreated\n');
    const staged = snapshot.units.find((unit) => unit.layer === 'staged');
    const untracked = snapshot.units.find((unit) => unit.layer === 'untracked');
    assert.equal(staged?.reason, 'deletion');
    assert.equal(untracked?.reason, 'addition');
    assert.deepEqual(untracked?.dependsOn, [staged?.id]);
  }));

test('sensitive names in any segment are visible without blob or filesystem content disclosure', () =>
  fixture(async (repo, local) => {
    await mkdir(join(repo, '.ssh'));
    await mkdir(join(repo, 'nested'));
    for (const name of [
      '.env',
      'nested/.env.prod',
      'nested/server.key',
      '.ssh/config',
      'nested/.npmrc',
    ])
      await writeFile(join(repo, name), 'SECRET_SENTINEL\n');
    git(
      repo,
      'add',
      '-f',
      '.env',
      'nested/.env.prod',
      'nested/server.key',
      '.ssh/config',
      'nested/.npmrc',
    );
    const blockedOids = new Set(
      git(repo, 'ls-files', '--stage')
        .split('\n')
        .filter((row) => !row.endsWith('\tsame.txt') && !row.endsWith('\t.gitignore'))
        .map((row) => row.split(' ')[1])
        .filter(Boolean),
    );
    const run = local.run.bind(local);
    local.run = (args, options) => {
      if (args[0] === 'cat-file')
        assert.ok(!blockedOids.has(args[2]), 'must not read a restricted Git blob');
      return run(args, options);
    };
    const snapshot = await readCommitPlanSnapshot(local);
    assert.ok(!JSON.stringify(snapshot).includes('SECRET_SENTINEL'));
    for (const item of snapshot.files) {
      assert.equal(item.worktree.kind, 'unavailable');
      if (item.index.kind === 'unavailable') assert.equal(item.index.reason, 'restrictedPath');
    }
    assert.equal(snapshot.files.length, 5);
    assert.ok(
      snapshot.units.every(
        (unit) => unit.kind === 'unsupported' && unit.reason === 'restrictedPath',
      ),
    );
    await writeFile(join(repo, '.env'), 'NEW_SECRET\n');
    assert.notEqual((await readCommitPlanSnapshot(local)).version, snapshot.version);
  }));

test('links, hardlinks, embedded repositories, gitlinks, and oversized content stay visible as unsupported', () =>
  fixture(async (repo, local, base) => {
    const outside = join(base, 'outside');
    await writeFile(outside, 'OUTSIDE_SENTINEL');
    await symlink(outside, join(repo, 'link.txt'));
    await link(outside, join(repo, 'hard.txt'));
    await mkdir(join(repo, 'embedded'));
    git(join(repo, 'embedded'), 'init', '-b', 'main');
    await writeFile(join(repo, 'large.txt'), 'x'.repeat(MAX_TEXT + 1));
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    git(repo, 'update-index', '--add', '--cacheinfo', '160000,' + head + ',module');
    const snapshot = await readCommitPlanSnapshot(local);
    for (const name of ['link.txt', 'hard.txt', 'embedded', 'large.txt', 'module']) {
      file(snapshot, name);
      assert.ok(
        snapshot.units.some((unit) => unit.path === name && unit.kind === 'unsupported'),
        name,
      );
    }
    assert.ok(!JSON.stringify(snapshot).includes('OUTSIDE_SENTINEL'));
    assert.equal(await readlink(join(repo, 'link.txt')), outside);
    assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE_SENTINEL');
  }));

test('conflicts preserve all three index stages and block splitting without changing the index', () =>
  fixture(async (repo, local) => {
    git(repo, 'checkout', '-b', 'other');
    await writeFile(join(repo, 'same.txt'), 'theirs\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'theirs');
    git(repo, 'checkout', 'main');
    await writeFile(join(repo, 'same.txt'), 'ours\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'ours');
    assert.throws(() => git(repo, 'merge', 'other'));
    const before = await readFile(join(repo, '.git/index'));
    const snapshot = await readCommitPlanSnapshot(local);
    assert.equal(snapshot.index.tree, null);
    assert.equal(snapshot.index.treeUnavailableReason, 'conflict');
    assert.deepEqual(
      file(snapshot, 'same.txt').conflictStages.map((entry) => entry.stage),
      [1, 2, 3],
    );
    assert.equal(snapshot.units.length, 1);
    assert.equal(snapshot.units[0]?.reason, 'conflict');
    assert.equal(snapshot.units[0]?.kind, 'unsupported');
    assert.match(text(file(snapshot, 'same.txt').worktree), /<<<<<<< HEAD/u);
    assert.deepEqual(await readFile(join(repo, '.git/index')), before);
  }));

test('intent-to-add, skip-worktree and assume-unchanged are explicit, even when status hides modifications', () =>
  fixture(async (repo, local) => {
    await writeFile(join(repo, 'hidden.txt'), 'original\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'tracked');
    git(repo, 'update-index', '--skip-worktree', 'same.txt');
    git(repo, 'update-index', '--assume-unchanged', 'hidden.txt');
    await writeFile(join(repo, 'same.txt'), 'hidden by skip\n');
    await writeFile(join(repo, 'hidden.txt'), 'hidden by assume\n');
    await writeFile(join(repo, 'intent.txt'), 'intent bytes\n');
    git(repo, 'add', '-N', 'intent.txt');
    const expectedTree = git(repo, 'write-tree').trim();
    const snapshot = await readCommitPlanSnapshot(local);
    assert.equal(snapshot.index.tree, expectedTree);
    assert.equal(file(snapshot, 'intent.txt').index.kind, 'missing');
    for (const name of ['same.txt', 'hidden.txt', 'intent.txt']) {
      const unit = snapshot.units.find((unit) => unit.path === name);
      assert.equal(unit?.kind, 'unsupported');
      assert.equal(unit?.reason, name === 'intent.txt' ? 'intentToAdd' : 'indexFlags');
      file(snapshot, name);
    }
  }));

test('attributes and configured clean filters cannot execute programs or yield executable text hunks', () =>
  fixture(async (repo, local, base) => {
    const marker = join(base, 'filter-ran');
    await writeFile(join(repo, '.gitattributes'), 'same.txt filter=marker\n');
    git(repo, 'config', 'filter.marker.clean', 'touch ' + marker);
    git(repo, 'config', 'filter.marker.process', 'touch ' + marker);
    await writeFile(join(repo, 'same.txt'), 'changed\n');
    // Reopen after adding the driver so LocalGit can explicitly disable it.
    const configured = await LocalGit.open(repo);
    const snapshot = await readCommitPlanSnapshot(configured);
    assert.equal(snapshot.units.find((unit) => unit.path === 'same.txt')?.reason, 'attributes');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(text(file(snapshot, 'same.txt').worktree), 'changed\n');
  }));

test('version changes for index, worktree, new paths, mode and HEAD while stable file identity survives edits', () =>
  fixture(async (repo, local) => {
    await writeFile(join(repo, 'same.txt'), 'B\n');
    git(repo, 'add', '.');
    const a = await readCommitPlanSnapshot(local);
    await writeFile(join(repo, 'same.txt'), 'C\n');
    const b = await readCommitPlanSnapshot(local);
    assert.notEqual(a.version, b.version);
    assert.equal(file(a, 'same.txt').id, file(b, 'same.txt').id);
    git(repo, 'add', '.');
    const c = await readCommitPlanSnapshot(local);
    assert.notEqual(b.version, c.version);
    await chmod(join(repo, 'same.txt'), 0o755);
    const d = await readCommitPlanSnapshot(local);
    assert.notEqual(c.version, d.version);
    await writeFile(join(repo, 'new.txt'), 'new\n');
    const e = await readCommitPlanSnapshot(local);
    assert.notEqual(d.version, e.version);
    git(repo, 'commit', '--allow-empty', '-m', 'advance');
    const f = await readCommitPlanSnapshot(local);
    assert.notEqual(e.version, f.version);
    git(repo, 'checkout', '-b', 'same-oid');
    const g = await readCommitPlanSnapshot(local);
    assert.notEqual(f.version, g.version);
  }));

test('racing worktree and index observations reject instead of returning a mixed snapshot', () =>
  fixture(async (repo, local) => {
    await writeFile(join(repo, 'same.txt'), 'B\n');
    git(repo, 'add', '.');
    const run = local.run.bind(local);
    let count = 0;
    local.run = async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'status' && ++count === 2) await writeFile(join(repo, 'same.txt'), 'raced\n');
      return result;
    };
    await assert.rejects(
      readCommitPlanSnapshot(local),
      (error: unknown) => error instanceof AppError && error.code === 'GIT_PLAN_STALE',
    );
    local.run = run;
    count = 0;
    local.run = async (args, options) => {
      const result = await run(args, options);
      if (args[0] === 'ls-files' && ++count === 1) {
        await writeFile(join(repo, 'same.txt'), 'new index\n');
        git(repo, 'add', '.');
      }
      return result;
    };
    await assert.rejects(
      readCommitPlanSnapshot(local),
      (error: unknown) => error instanceof AppError && error.code === 'GIT_PLAN_STALE',
    );
  }));

for (const format of ['sha1', 'sha256'] as const) {
  test(
    format +
      ' unborn snapshots compute exact empty and nested index trees without creating an index',
    () =>
      fixture(
        async (repo, local) => {
          const empty = await readCommitPlanSnapshot(local);
          assert.equal(empty.target.head, null);
          assert.equal(empty.index.fingerprint, null);
          assert.deepEqual(empty.files, []);
          await assert.rejects(readFile(join(repo, '.git/index')), { code: 'ENOENT' });
          assert.equal(empty.index.tree, git(repo, 'hash-object', '-t', 'tree', '--stdin').trim());
          for (const name of ['a.z', 'a/file', 'a0', 'z/space file', 'a/sub/child']) {
            await mkdir(join(repo, name, '..'), { recursive: true });
            await writeFile(join(repo, name), name + '\n');
          }
          git(repo, 'add', '.');
          const expectedTree = git(repo, 'write-tree').trim();
          const full = await readCommitPlanSnapshot(local);
          assert.equal(full.objectFormat, format);
          assert.equal(full.index.tree, expectedTree);
          assert.equal(full.units.length, 5);
          assert.ok(full.units.every((unit) => unit.layer === 'staged' && unit.kind === 'atomic'));
        },
        format,
        false,
      ),
  );
}

test('recreating a renamed source depends on the rename and protected rename sources stay excluded', () =>
  fixture(async (repo, local) => {
    await rename(join(repo, 'same.txt'), join(repo, 'renamed.txt'));
    git(repo, 'add', '-A');
    await writeFile(join(repo, 'same.txt'), 'new at old path\n');
    const snapshot = await readCommitPlanSnapshot(local);
    const renameUnit = snapshot.units.find((unit) => unit.path === 'renamed.txt');
    const untracked = snapshot.units.find((unit) => unit.path === 'same.txt');
    assert.equal(renameUnit?.reason, 'rename');
    assert.deepEqual(untracked?.dependsOn, [renameUnit?.id]);
    await writeFile(join(repo, '.env'), 'PRIVATE_RENAME_SENTINEL\n');
    git(repo, 'add', '-f', '.env');
    git(repo, 'commit', '-m', 'secret baseline');
    await rename(join(repo, '.env'), join(repo, 'ordinary.txt'));
    git(repo, 'add', '-A');
    const excluded = await readCommitPlanSnapshot(local);
    assert.equal(file(excluded, 'ordinary.txt').previousPath, '.env');
    assert.ok(!JSON.stringify(excluded).includes('PRIVATE_RENAME_SENTINEL'));
    assert.equal(excluded.units.find((unit) => unit.path === 'ordinary.txt')?.kind, 'unsupported');
  }));

test('CRLF and non-UTF8 changes stay exact atomic content and autocrlf cannot produce text hunks', () =>
  fixture(async (repo, local) => {
    await writeFile(join(repo, 'same.txt'), 'first\r\n');
    await writeFile(join(repo, 'legacy.dat'), Buffer.from([0xff, 0xfe, 1]));
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'bytes baseline');
    await writeFile(join(repo, 'same.txt'), 'second\r\n');
    await writeFile(join(repo, 'legacy.dat'), Buffer.from([0xff, 0xfe, 2]));
    const snapshot = await readCommitPlanSnapshot(local);
    assert.equal(snapshot.units.find((unit) => unit.path === 'same.txt')?.reason, 'lineEndings');
    assert.equal(snapshot.units.find((unit) => unit.path === 'legacy.dat')?.reason, 'binary');
    assert.equal(text(file(snapshot, 'same.txt').worktree), 'second\r\n');
    git(repo, 'config', 'core.autocrlf', 'true');
    const configured = await readCommitPlanSnapshot(local);
    assert.equal(configured.units.find((unit) => unit.path === 'same.txt')?.reason, 'attributes');
  }));

test('content budget keeps every candidate explicit and counts repeated blobs in serialized states', () =>
  fixture(async (repo, local) => {
    const bytes = 'x'.repeat(MAX_TEXT);
    for (let i = 0; i < 70; i++)
      await writeFile(join(repo, 'copy-' + String(i).padStart(3, '0') + '.txt'), bytes);
    git(repo, 'add', '.');
    const snapshot = await readCommitPlanSnapshot(local);
    assert.equal(snapshot.files.length, 70);
    assert.equal(snapshot.units.length, 70);
    const retained = snapshot.files
      .flatMap((file) => [file.head, file.index, file.worktree])
      .reduce((sum, state) => sum + (state.kind === 'file' ? state.size : 0), 0);
    assert.ok(retained <= 16 * 1024 * 1024);
    assert.ok(
      snapshot.units.some((unit) => unit.reason === 'budget' && unit.kind === 'unsupported'),
    );
    assert.ok(JSON.stringify(snapshot).length < 24 * 1024 * 1024);
  }));

test('detached HEAD is captured and cancellation returns no partial result', () =>
  fixture(async (repo, local) => {
    git(repo, 'checkout', '--detach');
    await writeFile(join(repo, 'same.txt'), 'changed\n');
    const snapshot = await readCommitPlanSnapshot(local);
    assert.equal(snapshot.target.ref, 'HEAD');
    assert.ok(snapshot.target.head);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readCommitPlanSnapshot(local, controller.signal), { name: 'AbortError' });
  }));
