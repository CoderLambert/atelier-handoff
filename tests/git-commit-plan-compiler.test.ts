/**
 * @file 验证多提交编译器的分块顺序、依赖和原索引剩余暂存语义。
 * @implementation 用纯内存三态快照核对精确内容、原子文件、错误计划与不可变结果；不执行 Git 或读写用户仓库。
 * @updated 2026-11-24T17:00:00+08:00
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { structuredPatch } from 'diff';
import {
  compileCommitPlan,
  type GitCommitPlanCompilation,
  type GitCommitPlanCompiledFile,
} from '../server/modules/git/commit-plan-compiler.js';
import type {
  GitCommitPlanFile,
  GitCommitPlanFileState,
  GitCommitPlanSnapshot,
  GitCommitPlanUnit,
} from '../server/modules/git/commit-plan-snapshot.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const missing: GitCommitPlanFileState = { kind: 'missing' };
function state(
  value: string | Buffer,
  mode = '100644',
  format: 'sha1' | 'sha256' = 'sha1',
): GitCommitPlanFileState {
  const bytes = Buffer.from(value);
  return {
    kind: 'file',
    mode,
    oid: createHash(format)
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex'),
    digest: digest(bytes),
    size: bytes.length,
    encoding: typeof value === 'string' ? 'utf8' : 'base64',
    content: typeof value === 'string' ? value : bytes.toString('base64'),
  };
}
function file(
  path: string,
  head: GitCommitPlanFileState,
  index: GitCommitPlanFileState,
  worktree: GitCommitPlanFileState,
): GitCommitPlanFile {
  return {
    id: digest(path),
    path,
    head,
    index,
    worktree,
    statuses: [],
    conflictStages: [],
    attributes: [],
  };
}
function layer(
  file: GitCommitPlanFile,
  name: 'staged' | 'unstaged' | 'untracked',
  kind: 'hunk' | 'atomic' = 'hunk',
): GitCommitPlanUnit[] {
  const from = name === 'staged' ? file.head : file.index;
  const to = name === 'staged' ? file.index : file.worktree;
  const common = { fileId: file.id, path: file.path, layer: name, dependsOn: [] };
  if (kind === 'atomic')
    return [
      {
        ...common,
        id: digest(file.path + name),
        kind,
        reason:
          from.kind === 'missing' ? 'addition' : to.kind === 'missing' ? 'deletion' : 'binary',
        hunk: null,
      },
    ];
  assert.equal(from.kind, 'file');
  assert.equal(to.kind, 'file');
  if (from.kind !== 'file' || to.kind !== 'file') throw new Error('fixture needs text');
  const patch = structuredPatch(
    file.path,
    file.path,
    from.content,
    to.content,
    undefined,
    undefined,
    { context: 3 },
  );
  assert.ok(patch);
  return patch.hunks.map((hunk, i) => ({
    ...common,
    id: digest(file.path + name + i),
    kind,
    reason: null,
    hunk,
  }));
}
function snapshot(files: GitCommitPlanFile[], units: GitCommitPlanUnit[]): GitCommitPlanSnapshot {
  for (const unit of units)
    if (unit.layer === 'unstaged' || unit.layer === 'untracked')
      unit.dependsOn = units
        .filter((other) => other.fileId === unit.fileId && other.layer === 'staged')
        .map((other) => other.id);
  return {
    formatVersion: 1,
    version: digest('snapshot'),
    repositoryId: 'fixture',
    rootIdentity: 'root',
    adminIdentity: 'admin',
    objectFormat: 'sha1',
    target: { ref: 'refs/heads/test', head: '1'.repeat(40), tree: '2'.repeat(40) },
    index: {
      fingerprint: digest('index'),
      tree: '3'.repeat(40),
      treeUnavailableReason: null,
      entries: files.flatMap((file) =>
        file.index.kind === 'file' && file.index.oid
          ? [{ path: file.path, oid: file.index.oid, mode: file.index.mode, stage: 0, flags: 0 }]
          : [],
      ),
    },
    configuration: '',
    ignored: [],
    files,
    units,
  };
}
function unitAt(units: GitCommitPlanUnit[], i: number) {
  const unit = units[i];
  assert.ok(unit);
  return unit;
}
function group(...units: GitCommitPlanUnit[]) {
  return { title: 'Commit changes', body: '', unitIds: units.map((unit) => unit.id) };
}
function compile(
  snap: GitCommitPlanSnapshot,
  groups: ReturnType<typeof group>[],
  excluded: GitCommitPlanUnit[] = [],
) {
  return compileCommitPlan(snap, { groups, excludedUnitIds: excluded.map((unit) => unit.id) });
}
function contents(
  files: readonly GitCommitPlanCompiledFile[],
  path: string,
): string | null | undefined {
  const result = files.find((file) => file.path === path);
  if (!result) return undefined;
  if (result.state.kind === 'missing') return null;
  return Buffer.from(
    result.state.content,
    result.state.encoding === 'utf8' ? 'utf8' : 'base64',
  ).toString();
}
function commit(result: GitCommitPlanCompilation, index: number) {
  const value = result.commits[index];
  assert.ok(value);
  return value;
}
function rejects(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'GIT_PLAN_' + code,
  );
}
const source = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1) + '\n').join('');

test('HEAD A / index B / worktree C compile distinct trees and advance the index without reverse staging', () => {
  const candidate = file('a.txt', state('A\n'), state('B\n'), state('C\n'));
  const staged = layer(candidate, 'staged');
  const unstaged = layer(candidate, 'unstaged');
  const snap = snapshot([candidate], [...staged, ...unstaged]);
  const before = JSON.stringify(snap);
  const result = compile(snap, [group(...staged), group(...unstaged)]);
  assert.equal(contents(commit(result, 0).tree.files, 'a.txt'), 'B\n');
  assert.deepEqual(commit(result, 0).index.files, []);
  assert.equal(contents(commit(result, 1).tree.files, 'a.txt'), 'C\n');
  assert.equal(contents(commit(result, 1).index.files, 'a.txt'), 'C\n');
  assert.deepEqual(result.finalIndex, commit(result, 1).index);
  assert.equal(JSON.stringify(snap), before);
  assert.equal(result.target.head, snap.target.head);
});

test('a group may contain both layers; dependency order is compiled even if input lists worktree first', () => {
  const candidate = file('a.txt', state('A\n'), state('B\n'), state('C\n'));
  const staged = layer(candidate, 'staged');
  const unstaged = layer(candidate, 'unstaged');
  const result = compile(snapshot([candidate], [...staged, ...unstaged]), [
    group(...unstaged, ...staged),
  ]);
  assert.deepEqual(
    commit(result, 0).unitIds,
    [...staged, ...unstaged].map((unit) => unit.id),
  );
  assert.equal(contents(commit(result, 0).tree.files, 'a.txt'), 'C\n');
  assert.equal(contents(result.finalIndex.files, 'a.txt'), 'C\n');
});

test('two staged hunks can be grouped in reverse source order while leaving an excluded staged hunk in the final index', () => {
  const indexed = source
    .replace('line 2\n', 'line two\n')
    .replace('line 27\n', 'line twenty-seven\n');
  const candidate = file('a.txt', state(source), state(indexed), state(indexed));
  const staged = layer(candidate, 'staged');
  assert.equal(staged.length, 2);
  const snap = snapshot([candidate], staged);
  const partial = compile(snap, [group(unitAt(staged, 1))], [unitAt(staged, 0)]);
  assert.equal(
    contents(commit(partial, 0).tree.files, 'a.txt'),
    source.replace('line 27\n', 'line twenty-seven\n'),
  );
  // Empty overrides mean restore/preserve the original full B index, including the excluded block.
  assert.deepEqual(partial.finalIndex.files, []);
  const all = compile(snap, [group(unitAt(staged, 1)), group(unitAt(staged, 0))]);
  assert.equal(
    contents(commit(all, 0).tree.files, 'a.txt'),
    source.replace('line 27\n', 'line twenty-seven\n'),
  );
  assert.equal(contents(commit(all, 1).tree.files, 'a.txt'), indexed);
  assert.deepEqual(all.finalIndex.files, []);
});

test('independent unstaged hunks accumulate from index coordinates despite inserted lines and reversed group order', () => {
  const working = source
    .replace('line 2\n', 'line two\ninserted\n')
    .replace('line 27\n', 'line twenty-seven\n');
  const candidate = file('a.txt', state(source), state(source), state(working));
  const workspace = layer(candidate, 'unstaged');
  assert.equal(workspace.length, 2);
  const snap = snapshot([candidate], workspace);
  const partial = compile(snap, [group(unitAt(workspace, 1))], [unitAt(workspace, 0)]);
  const secondOnly = source.replace('line 27\n', 'line twenty-seven\n');
  assert.equal(contents(commit(partial, 0).tree.files, 'a.txt'), secondOnly);
  assert.equal(contents(partial.finalIndex.files, 'a.txt'), secondOnly);
  const result = compile(snap, [group(unitAt(workspace, 1)), group(unitAt(workspace, 0))]);
  assert.equal(contents(commit(result, 0).tree.files, 'a.txt'), secondOnly);
  assert.equal(contents(commit(result, 1).tree.files, 'a.txt'), working);
  assert.equal(contents(result.finalIndex.files, 'a.txt'), working);
});

test('staged and unstaged blocks preserve other files remaining staged and excluded unstaged blocks', () => {
  const indexed = source.replace('line 2\n', 'line two\n');
  const working = indexed
    .replace('line 15\n', 'line fifteen\n')
    .replace('line 28\n', 'line twenty-eight\n');
  const a = file('a.txt', state(source), state(indexed), state(working));
  const b = file('b.txt', state('old\n'), state('staged\n'), state('staged\n'));
  const staged = layer(a, 'staged');
  const workspace = layer(a, 'unstaged');
  const retained = layer(b, 'staged');
  assert.equal(workspace.length, 2);
  const result = compile(
    snapshot([a, b], [...staged, ...workspace, ...retained]),
    [group(...staged), group(unitAt(workspace, 1))],
    [unitAt(workspace, 0), ...retained],
  );
  assert.equal(
    contents(commit(result, 1).tree.files, 'a.txt'),
    indexed.replace('line 28\n', 'line twenty-eight\n'),
  );
  assert.equal(
    contents(result.finalIndex.files, 'a.txt'),
    indexed.replace('line 28\n', 'line twenty-eight\n'),
  );
  assert.equal(contents(result.finalIndex.files, 'b.txt'), undefined);
  assert.equal(contents(commit(result, 1).tree.files, 'b.txt'), undefined);
});

test('dependencies cannot follow their consumer or be excluded, and worktree depends on every staged hunk', () => {
  const indexed = source.replace('line 2\n', 'two\n').replace('line 28\n', 'twenty-eight\n');
  const candidate = file('a.txt', state(source), state(indexed), state(indexed + 'tail\n'));
  const staged = layer(candidate, 'staged');
  const workspace = layer(candidate, 'unstaged');
  const snap = snapshot([candidate], [...staged, ...workspace]);
  rejects(() => compile(snap, [group(...workspace), group(...staged)]), 'DEPENDENCY');
  rejects(
    () => compile(snap, [group(unitAt(staged, 0), ...workspace)], [unitAt(staged, 1)]),
    'DEPENDENCY',
  );
  unitAt(workspace, 0).dependsOn = [unitAt(staged, 0).id];
  rejects(() => compile(snap, [group(...staged), group(...workspace)]), 'INVALID_SNAPSHOT');
});

test('added, deleted, binary and mode-changing files compile atomically with exact bytes and modes', () => {
  const binary = Buffer.from([0, 255, 13, 10, 128]);
  const files = [
    file('added', missing, missing, state('new\n')),
    file('deleted', state('old\n'), missing, missing),
    file('binary', state(Buffer.from([0, 1])), state(Buffer.from([0, 1])), state(binary)),
    file('executable', state('run\n'), state('run\n'), state('run\n', '100755')),
  ];
  const units = files.flatMap((candidate, i) =>
    layer(candidate, i === 0 ? 'untracked' : i === 1 ? 'staged' : 'unstaged', 'atomic'),
  );
  const result = compile(snapshot(files, units), [group(...units)]);
  const changes = commit(result, 0).tree.files;
  assert.equal(contents(changes, 'added'), 'new\n');
  assert.equal(contents(changes, 'deleted'), null);
  const output = changes.find((row) => row.path === 'binary')?.state;
  assert.ok(output?.kind === 'file');
  assert.deepEqual(
    Buffer.from(output.content, output.encoding === 'base64' ? 'base64' : 'utf8'),
    binary,
  );
  const executable = changes.find((row) => row.path === 'executable')?.state;
  assert.ok(executable?.kind === 'file');
  assert.equal(executable.mode, '100755');
  assert.equal(contents(result.finalIndex.files, 'deleted'), undefined);
  assert.equal(contents(result.finalIndex.files, 'added'), 'new\n');
});

test('staged addition then worktree deletion leaves no reverse-staged file', () => {
  const candidate = file('transient', missing, state('added\n'), missing);
  const staged = layer(candidate, 'staged', 'atomic');
  const workspace = layer(candidate, 'unstaged', 'atomic');
  const snap = snapshot([candidate], [...staged, ...workspace]);
  const result = compile(snap, [group(...staged), group(...workspace)]);
  assert.deepEqual(commit(result, 1).tree.files, []);
  assert.equal(contents(result.finalIndex.files, 'transient'), null);
  rejects(() => compile(snap, [group(...staged, ...workspace)]), 'EMPTY_GROUP');
});

test('text hunks preserve missing final newlines and insertion/deletion at boundaries', () => {
  for (const [before, after] of [
    ['first\nlast', 'first\nchanged'],
    ['first\nlast\n', 'first\nlast'],
    ['first\n', 'inserted\nfirst\n'],
    ['first\nlast\n', 'first\n'],
    ['', 'first\n'],
    ['first\n', ''],
  ] as const) {
    const candidate = file('text', state(before), state(before), state(after));
    const units = layer(candidate, 'unstaged');
    const result = compile(snapshot([candidate], units), [group(...units)]);
    assert.equal(contents(commit(result, 0).tree.files, 'text'), after);
    assert.equal(contents(result.finalIndex.files, 'text'), after);
  }
});

test('coverage is exact: unknown IDs, duplicates across groups/exclusions and missing IDs are rejected', () => {
  const candidate = file('a.txt', state('A\n'), state('B\n'), state('C\n'));
  const staged = layer(candidate, 'staged');
  const workspace = layer(candidate, 'unstaged');
  const snap = snapshot([candidate], [...staged, ...workspace]);
  rejects(
    () =>
      compileCommitPlan(snap, {
        groups: [{ ...group(...staged), unitIds: ['unknown'] }],
        excludedUnitIds: workspace.map((unit) => unit.id),
      }),
    'UNKNOWN_UNIT',
  );
  rejects(
    () => compile(snap, [group(...staged), group(...staged, ...workspace)]),
    'DUPLICATE_UNIT',
  );
  rejects(() => compile(snap, [group(...staged, ...staged, ...workspace)]), 'DUPLICATE_UNIT');
  rejects(() => compile(snap, [group(...staged, ...workspace)], staged), 'DUPLICATE_UNIT');
  rejects(() => compile(snap, [group(...staged)], [...workspace, ...workspace]), 'DUPLICATE_UNIT');
  rejects(() => compile(snap, [group(...staged)]), 'UNASSIGNED_UNIT');
});

test('empty groups and invalid commit messages fail before compilation', () => {
  const candidate = file('a.txt', state('A\n'), state('B\n'), state('B\n'));
  const units = layer(candidate, 'staged');
  const snap = snapshot([candidate], units);
  for (const input of [
    { groups: [], excludedUnitIds: units.map((unit) => unit.id) },
    { groups: [group()], excludedUnitIds: units.map((unit) => unit.id) },
    ...[' ', 'bad\ntitle', 'bad\0title', 'x'.repeat(241)].map((title) => ({
      groups: [{ ...group(...units), title }],
      excludedUnitIds: [],
    })),
    { groups: [{ ...group(...units), body: 'nul\0body' }], excludedUnitIds: [] },
    { groups: [{ ...group(...units), body: 'x'.repeat(8001) }], excludedUnitIds: [] },
    { groups: [group(...units)] },
  ])
    rejects(() => compileCommitPlan(snap, input), 'INVALID');
});

test('selected unsupported units and renames fail closed; explicit unsupported exclusions preserve original index', () => {
  const a = file('a', state('A\n'), state('B\n'), state('B\n'));
  const b = file('restricted', missing, missing, {
    kind: 'unavailable',
    reason: 'restrictedPath',
    oid: null,
    mode: null,
    fingerprint: digest('private'),
  });
  const units = layer(a, 'staged');
  const unsupported: GitCommitPlanUnit = {
    id: digest('unsupported'),
    fileId: b.id,
    path: b.path,
    kind: 'unsupported',
    layer: 'untracked',
    reason: 'restrictedPath',
    hunk: null,
    dependsOn: [],
  };
  const snap = snapshot([a, b], [...units, unsupported]);
  rejects(() => compile(snap, [group(...units, unsupported)]), 'UNSUPPORTED');
  const result = compile(snap, [group(...units)], [unsupported]);
  assert.deepEqual(result.finalIndex.files, []);
  const renamed = unitAt(units, 0);
  renamed.kind = 'atomic';
  renamed.reason = 'rename';
  renamed.hunk = null;
  rejects(() => compile(snap, [group(...units)], [unsupported]), 'UNSUPPORTED');
  snap.index.treeUnavailableReason = 'conflict';
  rejects(() => compile(snap, [group(...units)], [unsupported]), 'UNSUPPORTED');
});

test('tampered hunk content, coordinates, overlaps, duplicate identities and cyclic dependencies fail closed', () => {
  const make = () => {
    const candidate = file(
      'a',
      state(source),
      state(source.replace('line 2\n', 'two\n').replace('line 28\n', 'twenty-eight\n')),
      state(source),
    );
    const units = layer(candidate, 'staged');
    return { candidate, units, snap: snapshot([candidate], units) };
  };
  const altered = make();
  const alteredHunk = unitAt(altered.units, 0).hunk;
  assert.ok(alteredHunk);
  alteredHunk.lines[0] = ' wrong context';
  rejects(() => compile(altered.snap, [group(...altered.units)]), 'UNSAFE_HUNK');
  const shifted = make();
  const shiftedHunk = unitAt(shifted.units, 0).hunk;
  assert.ok(shiftedHunk);
  shiftedHunk.oldStart += 1;
  shiftedHunk.newStart += 1;
  rejects(() => compile(shifted.snap, [group(...shifted.units)]), 'UNSAFE_HUNK');
  const overlap = make();
  unitAt(overlap.units, 1).hunk = unitAt(overlap.units, 0).hunk;
  rejects(() => compile(overlap.snap, [group(...overlap.units)]), 'UNSAFE_HUNK');
  const duplicate = make();
  unitAt(duplicate.units, 1).id = unitAt(duplicate.units, 0).id;
  rejects(() => compile(duplicate.snap, [group(...duplicate.units)]), 'INVALID_SNAPSHOT');
  const cyclic = make();
  unitAt(cyclic.units, 0).dependsOn = [unitAt(cyclic.units, 1).id];
  unitAt(cyclic.units, 1).dependsOn = [unitAt(cyclic.units, 0).id];
  rejects(() => compile(cyclic.snap, [group(...cyclic.units)]), 'INVALID_SNAPSHOT');
  const corrupted = make();
  assert.ok(corrupted.candidate.index.kind === 'file');
  corrupted.candidate.index.content += 'unhashed';
  rejects(() => compile(corrupted.snap, [group(...corrupted.units)]), 'INVALID_SNAPSHOT');
});

test('file/directory collisions are checked at every commit and index phase', () => {
  const removed = file('a', state('old'), missing, missing);
  const added = file('a/b', missing, missing, state('new'));
  const deleted = layer(removed, 'staged', 'atomic');
  const created = layer(added, 'untracked', 'atomic');
  const snap = snapshot([removed, added], [...deleted, ...created]);
  rejects(() => compile(snap, [group(...created), group(...deleted)]), 'PATH_CONFLICT');
  const result = compile(snap, [group(...deleted), group(...created)]);
  assert.equal(contents(commit(result, 1).tree.files, 'a'), null);
  assert.equal(contents(result.finalIndex.files, 'a/b'), 'new');
});

test('compiled snapshots are deeply immutable and independent of later input mutation', () => {
  const candidate = file('a', state('A\n'), state('B\n'), state('C\n'));
  const staged = layer(candidate, 'staged');
  const workspace = layer(candidate, 'unstaged');
  const snap = snapshot([candidate], [...staged, ...workspace]);
  const result = compile(snap, [group(...staged), group(...workspace)]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.commits));
  const last = commit(result, 1);
  const row = last.tree.files[0];
  assert.ok(row);
  assert.ok(Object.isFrozen(last));
  assert.ok(Object.isFrozen(last.unitIds));
  assert.ok(Object.isFrozen(last.tree));
  assert.ok(Object.isFrozen(last.tree.files));
  assert.ok(Object.isFrozen(row));
  assert.ok(Object.isFrozen(row.state));
  assert.ok(candidate.worktree.kind === 'file');
  candidate.worktree.content = 'later edit';
  snap.target.head = 'f'.repeat(40);
  assert.equal(contents(last.tree.files, 'a'), 'C\n');
  assert.equal(result.target.head, '1'.repeat(40));
});

test('context-free insertions and deletions use exact zero-length hunk coordinates', () => {
  for (const [before, after] of [
    ['a\nb\n', 'x\na\nb\n'],
    ['a\nb\n', 'a\nb\nx\n'],
    ['a\nb\n', 'b\n'],
    ['a\nb\n', 'a\n'],
  ] as const) {
    const candidate = file('a', state(before), state(before), state(after));
    const units = layer(candidate, 'unstaged');
    const patch = structuredPatch('a', 'a', before, after, undefined, undefined, { context: 0 });
    assert.ok(patch);
    assert.equal(patch.hunks.length, 1);
    unitAt(units, 0).hunk = patch.hunks[0] ?? null;
    const result = compile(snapshot([candidate], units), [group(...units)]);
    assert.equal(contents(result.finalIndex.files, 'a'), after);
  }
});

test('incomplete staged layers, mismatched index metadata and mixed unsupported layers fail closed', () => {
  const a = file('a', state('A\n'), state('B\n'), state('C\n'));
  const workspace = layer(a, 'unstaged');
  rejects(() => compile(snapshot([a], workspace), [group(...workspace)]), 'INVALID_SNAPSHOT');
  const staged = layer(a, 'staged');
  const snap = snapshot([a], [...staged, ...workspace]);
  const entry = snap.index.entries[0];
  assert.ok(entry);
  entry.mode = '100755';
  rejects(() => compile(snap, [group(...staged, ...workspace)]), 'INVALID_SNAPSHOT');
  entry.mode = '100644';
  const unsupported: GitCommitPlanUnit = {
    ...unitAt(staged, 0),
    id: digest('extra unsupported'),
    kind: 'unsupported',
    reason: 'diffLimit',
    hunk: null,
  };
  snap.units.push(unsupported);
  for (const unit of workspace) unit.dependsOn.push(unsupported.id);
  rejects(() => compile(snap, [group(...staged)], [...workspace, unsupported]), 'UNSUPPORTED');
});

test('a no-newline marker cannot merge unchanged following lines into a forged hunk', () => {
  const candidate = file('a', state('a\nb\n'), state('a\nb\n'), state('xb\n'));
  const units = layer(candidate, 'unstaged');
  unitAt(units, 0).hunk = {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: ['-a', '+x', '\\ No newline at end of file'],
  };
  rejects(() => compile(snapshot([candidate], units), [group(...units)]), 'UNSAFE_HUNK');
});

test('many unchanged lines do not exhaust the argument stack while rebuilding a small hunk', () => {
  const text = 'unchanged\n'.repeat(150_000) + 'before\n';
  const candidate = file(
    'large',
    state(text),
    state(text),
    state(text.replace(/before\n$/u, 'after\n')),
  );
  const units = layer(candidate, 'unstaged');
  const result = compile(snapshot([candidate], units), [group(...units)]);
  assert.equal(contents(result.finalIndex.files, 'large'), text.replace(/before\n$/u, 'after\n'));
});

test('unborn HEAD and SHA-256 blobs retain exact content identities', () => {
  const candidate = file('first', missing, missing, state('initial\n', '100644', 'sha256'));
  const units = layer(candidate, 'untracked', 'atomic');
  const snap = snapshot([candidate], units);
  snap.objectFormat = 'sha256';
  snap.target = { ref: 'refs/heads/new', head: null, tree: null };
  const result = compile(snap, [group(...units)]);
  const output = commit(result, 0).tree.files[0]?.state;
  assert.ok(output?.kind === 'file');
  assert.equal(output.oid?.length, 64);
  assert.equal(contents(result.finalIndex.files, 'first'), 'initial\n');
});
