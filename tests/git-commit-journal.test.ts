/**
 * @file 验证多提交恢复日志的持久化、冲突和私有文件边界。
 * @implementation 在独立临时目录核对重启、索引备份引用、锁 inode 归属、并发与同步故障，不调用 Git 或访问用户索引。
 * @updated 2026-11-24T15:55:24+08:00
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import {
  CommitJournal,
  CommitJournalError,
  MAX_COMMIT_JOURNAL_INDEX_BYTES,
  hashCommitJournalIndex,
  hashCommitJournalRequest,
  type CommitJournalErrorCode,
  type CommitJournalObservation,
  type CommitJournalPrepare,
} from '../server/modules/git/commit-journal.js';

const exec = promisify(execFile);
const oldHead = 'a'.repeat(40);
const middleHead = 'b'.repeat(40);
const newHead = 'c'.repeat(40);
function request(overrides: Partial<CommitJournalPrepare> = {}): CommitJournalPrepare {
  const original = Buffer.from([0, 255, 10, 13, 128]);
  const target = Buffer.from([0, 128, 1, 2, 3]);
  return {
    operationId: randomUUID(),
    requestHash: hashCommitJournalRequest({ plan: 'fixture secret plan', groups: [1, 2] }),
    repositoryId: '/fixture/common\0' + '1:2',
    worktreeIdentity: '1:3',
    adminIdentity: '1:4',
    indexLockIdentity: '1:5',
    ref: 'refs/heads/fixture',
    oldHead,
    newHead,
    commits: [middleHead, newHead],
    originalIndex: { hash: hashCommitJournalIndex(original), bytes: original },
    targetIndex: { hash: hashCommitJournalIndex(target), bytes: target },
    ...overrides,
  };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-commit-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await mkdir(data, { mode: 0o700 });
  return { root, data, directory: join(data, 'commit-journal'), journal: new CommitJournal(data) };
}
function observation(
  value: CommitJournalPrepare,
  overrides: Partial<CommitJournalObservation> = {},
): CommitJournalObservation {
  return {
    repositoryId: value.repositoryId,
    worktreeIdentity: value.worktreeIdentity,
    adminIdentity: value.adminIdentity,
    ref: value.ref,
    head: value.oldHead,
    indexHash: value.originalIndex.hash,
    indexLock: {
      state: 'owned',
      operationId: value.operationId,
      identity: value.indexLockIdentity,
    },
    ...overrides,
  };
}
const rejected = (promise: Promise<unknown>, code: CommitJournalErrorCode) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof CommitJournalError && error.code === code,
  );
const entryPath = (directory: string, value: CommitJournalPrepare, revision = 1) =>
  join(directory, value.operationId + '.' + revision, 'entry.json');
const storedImage = (value: CommitJournalPrepare, kind: 'original' | 'target') => ({
  ...(kind === 'original' ? value.originalIndex : value.targetIndex),
  file: `commit-journal/${value.operationId}.1/${kind}.index`,
});
const transition = (
  value: CommitJournalPrepare,
  expectedRevision: number,
  state: 'ref_updated' | 'completed' | 'recovery_required' | 'aborting' | 'aborted',
  recoveryReason?: string,
) => ({
  operationId: value.operationId,
  requestHash: value.requestHash,
  expectedRevision,
  state,
  ...(recoveryReason === undefined ? {} : { recoveryReason }),
});

test('request digests preserve JSON semantics and reject lossy or executable input', () => {
  assert.equal(
    hashCommitJournalRequest({ b: [2, { z: 3, a: 1 }], a: 'x' }),
    hashCommitJournalRequest({ a: 'x', b: [2, { a: 1, z: 3 }] }),
  );
  assert.notEqual(hashCommitJournalRequest([1, 2]), hashCommitJournalRequest([2, 1]));
  assert.notEqual(hashCommitJournalRequest({ a: 1 }), hashCommitJournalRequest({ a: '1' }));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let invoked = false;
  const accessor = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get: () => {
      invoked = true;
      return 'secret';
    },
  });
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    new Date(),
    Buffer.from('x'),
    cycle,
    { a: undefined },
    [undefined],
    new Array(1),
    { [Symbol('x')]: 1 },
    accessor,
  ]) {
    assert.throws(() => hashCommitJournalRequest(value), { code: 'INVALID_INPUT' });
  }
  assert.equal(invoked, false);
  assert.equal(hashCommitJournalIndex(null), null);
  assert.notEqual(hashCommitJournalIndex(Buffer.alloc(0)), null);
  assert.throws(() => hashCommitJournalIndex(Buffer.alloc(MAX_COMMIT_JOURNAL_INDEX_BYTES + 1)), {
    code: 'INVALID_INPUT',
  });
});

describe('private commit journal', { skip: process.platform !== 'linux' }, () => {
  test('prepare is durable and idempotent across instances, with copied binary evidence', async (t) => {
    const { data, directory, journal } = await fixture(t);
    const value = request();
    assert.equal(await journal.read(value.operationId), undefined);
    assert.deepEqual(await journal.pending(), []);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    const pending = journal.prepare(value);
    const expected = Buffer.from(value.originalIndex.bytes ?? []);
    value.originalIndex.bytes?.fill(17);
    const saved = await pending;
    assert.equal(saved.state, 'prepared');
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.originalIndex.bytes, expected);
    const reopened = new CommitJournal(data);
    assert.deepEqual(await reopened.read(value.operationId), saved);
    const originalRequest = {
      ...value,
      originalIndex: { hash: saved.originalIndex.hash, bytes: saved.originalIndex.bytes },
    };
    assert.deepEqual(await reopened.prepare(originalRequest), saved);
    assert.deepEqual(await reopened.pending(), [saved]);
    saved.originalIndex.bytes?.fill(99);
    const restored = await reopened.read(value.operationId);
    assert.deepEqual(restored?.originalIndex.bytes, expected);
    assert.deepEqual(restored?.commits, [middleHead, newHead]);
    assert.doesNotMatch(
      await readFile(entryPath(directory, value), 'utf8'),
      /fixture secret plan/u,
    );
  });

  test('same ID rejects changed digest, identities, commits, reference, HEAD or either image', async (t) => {
    const { journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    const changedBytes = Buffer.from('changed');
    for (const changed of [
      { requestHash: 'd'.repeat(64) },
      { repositoryId: 'another' },
      { worktreeIdentity: '5:6' },
      { adminIdentity: '5:7' },
      { indexLockIdentity: '5:8' },
      { ref: 'refs/heads/other' },
      { oldHead: 'd'.repeat(40) },
      { commits: [newHead] },
      { originalIndex: { bytes: changedBytes, hash: hashCommitJournalIndex(changedBytes) } },
      { targetIndex: { bytes: changedBytes, hash: hashCommitJournalIndex(changedBytes) } },
    ])
      await rejected(journal.prepare({ ...value, ...changed }), 'REQUEST_CONFLICT');
    assert.equal((await journal.read(value.operationId))?.revision, 1);
  });

  test('orphan owner metadata survives restart and is frozen without breaking standalone prepares', async (t) => {
    const { data, journal } = await fixture(t);
    const owner = {
      projectId: randomUUID(),
      requestDigest: hashCommitJournalRequest({ frontendPlan: 'orphan fixture' }),
    };
    const expectedOwner = { ...owner };
    const value = request({ owner });
    const pending = journal.prepare(value);
    owner.projectId = randomUUID();
    owner.requestDigest = 'd'.repeat(64);
    const saved = await pending;
    assert.equal(saved.state, 'prepared');
    assert.deepEqual(saved.owner, expectedOwner);
    const restarted = new CommitJournal(data);
    assert.deepEqual((await restarted.read(value.operationId))?.owner, expectedOwner);
    assert.deepEqual(
      (await restarted.pending()).map((record) => record.owner),
      [expectedOwner],
    );
    assert.deepEqual(await restarted.prepare({ ...value, owner: expectedOwner }), saved);
    for (const changedOwner of [
      undefined,
      { ...expectedOwner, projectId: randomUUID() },
      { ...expectedOwner, requestDigest: 'e'.repeat(64) },
    ])
      await rejected(restarted.prepare({ ...value, owner: changedOwner }), 'REQUEST_CONFLICT');
    const advanced = await restarted.transition(transition(value, 1, 'ref_updated'));
    assert.deepEqual(advanced.owner, expectedOwner);
    assert.deepEqual((await new CommitJournal(data).read(value.operationId))?.owner, expectedOwner);
    const standalone = request();
    assert.equal((await journal.prepare(standalone)).owner, undefined);
    await rejected(journal.prepare({ ...standalone, owner: expectedOwner }), 'REQUEST_CONFLICT');
  });

  test('owner metadata validates on disk and later history cannot change orphan attribution', async (t) => {
    const { data, directory, journal } = await fixture(t);
    const owner = { projectId: randomUUID(), requestDigest: 'd'.repeat(64) };
    const value = request({ owner });
    await journal.prepare(value);
    const first = entryPath(directory, value);
    const original = await readFile(first, 'utf8');
    for (const bytes of [
      original.replace(owner.projectId, 'invalid-project'),
      original.replace(owner.requestDigest, 'invalid-digest'),
    ]) {
      await writeFile(first, bytes);
      await rejected(new CommitJournal(data).read(value.operationId), 'CORRUPT');
      assert.equal(await readFile(first, 'utf8'), bytes);
    }
    await writeFile(first, original);
    await journal.transition(transition(value, 1, 'ref_updated'));
    const second = entryPath(directory, value, 2);
    const encoded = await readFile(second, 'utf8');
    for (const bytes of [
      encoded.replace(owner.projectId, randomUUID()),
      encoded.replace(owner.requestDigest, 'e'.repeat(64)),
    ]) {
      await writeFile(second, bytes);
      await rejected(new CommitJournal(data).read(value.operationId), 'CORRUPT');
      await rejected(journal.prepare(value), 'CORRUPT');
      assert.equal(await readFile(second, 'utf8'), bytes);
    }
    await writeFile(second, encoded);
    assert.deepEqual((await journal.read(value.operationId))?.owner, owner);
  });

  test('validation rejects unsafe IDs, invalid refs, hashes, images, OIDs and commit lists before creating storage', async (t) => {
    const { directory, journal } = await fixture(t);
    const value = request();
    const invalid: unknown[] = [
      null,
      {},
      { ...value, extra: true },
      ...[
        '../escape',
        '/tmp/escape',
        value.operationId.toUpperCase(),
        value.operationId + '/x',
      ].map((operationId) => ({ ...value, operationId })),
      ...[
        'refs/tags/x',
        'refs/heads/a..b',
        'refs/heads/.hidden',
        'refs/heads/a.lock',
        'refs/heads/a//b',
        'refs/heads/a@{b',
        'refs/heads/a b',
        'refs/heads/a\\b',
        'refs/heads/a^b',
        'refs/heads/a[b',
        'refs/heads/a.',
        'refs/heads/-x',
      ].map((ref) => ({ ...value, ref })),
      ...[
        undefined,
        '',
        'not-an-identity',
        '1:0',
        '-1:2',
        '01:2',
        '1:02',
        '1:2:3',
        '1:2\n',
        '18446744073709551616:1',
        '1:18446744073709551616',
      ].map((indexLockIdentity) => ({ ...value, indexLockIdentity })),
      ...[
        null,
        {},
        { projectId: randomUUID() },
        { requestDigest: 'd'.repeat(64) },
        { projectId: '../project', requestDigest: 'd'.repeat(64) },
        { projectId: randomUUID(), requestDigest: 'not-a-digest' },
        { projectId: randomUUID(), requestDigest: 'd'.repeat(64), extra: true },
      ].map((owner) => ({ ...value, owner })),
      { ...value, requestHash: 'not-a-digest' },
      { ...value, oldHead: newHead },
      { ...value, oldHead: '0'.repeat(40) },
      { ...value, oldHead: 'e'.repeat(64) },
      { ...value, ref: 'HEAD', oldHead: null },
      { ...value, originalIndex: { hash: value.originalIndex.hash, bytes: null } },
      { ...value, targetIndex: { hash: null, bytes: Buffer.alloc(0) } },
      { ...value, originalIndex: { hash: value.originalIndex.hash, bytes: new Uint8Array([1]) } },
      { ...value, targetIndex: { hash: 'a'.repeat(64), bytes: Buffer.from('mismatch') } },
      { ...value, commits: [] },
      { ...value, commits: [middleHead] },
      { ...value, commits: [newHead, newHead] },
      { ...value, commits: [oldHead, newHead] },
      { ...value, commits: ['f'.repeat(64), newHead] },
      { ...value, commits: Array(121).fill(newHead) },
    ];
    for (const bad of invalid) await rejected(journal.prepare(bad), 'INVALID_INPUT');
    await rejected(journal.read('../escape'), 'INVALID_INPUT');
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
  });

  test('missing and empty index remain distinct, and unborn and SHA256 histories survive restart', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request({
      oldHead: null,
      originalIndex: { hash: null, bytes: null },
      targetIndex: { hash: hashCommitJournalIndex(Buffer.alloc(0)), bytes: Buffer.alloc(0) },
      newHead: 'c'.repeat(64),
      commits: ['b'.repeat(64), 'c'.repeat(64)],
    });
    await journal.prepare(value);
    const restored = await new CommitJournal(data).read(value.operationId);
    assert.equal(restored?.originalIndex.hash, null);
    assert.equal(restored?.originalIndex.bytes, null);
    assert.deepEqual(restored?.targetIndex.bytes, Buffer.alloc(0));
    assert.ok(restored);
    assert.notEqual(restored.originalIndex.file, restored.targetIndex.file);
    assert.deepEqual(await readFile(join(data, restored.originalIndex.file)), Buffer.alloc(0));
    assert.deepEqual(await readFile(join(data, restored.targetIndex.file)), Buffer.alloc(0));
    assert.equal(
      (await journal.reconcile(value.operationId, observation(value))).decision,
      'ready',
    );
    assert.equal(
      (
        await journal.reconcile(
          value.operationId,
          observation(value, { head: value.newHead, indexHash: value.targetIndex.hash }),
        )
      ).decision,
      'completed',
    );
  });

  test('state transitions require CAS, forbid skips, and return durable retry results', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    await rejected(journal.transition(transition(value, 1, 'completed')), 'INVALID_TRANSITION');
    await rejected(
      journal.transition({ ...transition(value, 1, 'ref_updated'), requestHash: 'd'.repeat(64) }),
      'REQUEST_CONFLICT',
    );
    await rejected(journal.transition(transition(value, 2, 'ref_updated')), 'VERSION_CONFLICT');
    await rejected(journal.transition(transition(value, 1, 'recovery_required')), 'INVALID_INPUT');
    await rejected(
      journal.transition({ ...transition(value, 1, 'ref_updated'), recoveryReason: 'extra' }),
      'INVALID_INPUT',
    );
    const advanced = await journal.transition(transition(value, 1, 'ref_updated'));
    const restarted = new CommitJournal(data);
    assert.deepEqual(await restarted.transition(transition(value, 1, 'ref_updated')), advanced);
    const completed = await restarted.transition(transition(value, 2, 'completed'));
    assert.equal(completed.revision, 3);
    assert.equal(completed.state, 'completed');
    assert.deepEqual(await new CommitJournal(data).prepare(value), completed);
    assert.deepEqual(await journal.transition(transition(value, 2, 'completed')), completed);
    await rejected(journal.transition(transition(value, 1, 'ref_updated')), 'VERSION_CONFLICT');
    await rejected(
      journal.transition(transition(value, 3, 'recovery_required', 'late')),
      'INVALID_TRANSITION',
    );
    assert.deepEqual(await journal.pending(), []);
    await rejected(journal.transition(transition(request(), 1, 'ref_updated')), 'NOT_FOUND');
  });

  test('recovery_required preserves evidence and cannot automatically resume', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    const blocked = await journal.transition(
      transition(value, 1, 'recovery_required', 'foreign lock'),
    );
    assert.equal(blocked.recoveryReason, 'foreign lock');
    assert.deepEqual(await new CommitJournal(data).pending(), [blocked]);
    assert.deepEqual(
      await journal.transition(transition(value, 1, 'recovery_required', 'foreign lock')),
      blocked,
    );
    await rejected(
      journal.transition(transition(value, 1, 'recovery_required', 'different')),
      'VERSION_CONFLICT',
    );
    await rejected(journal.transition(transition(value, 2, 'ref_updated')), 'INVALID_TRANSITION');
    assert.equal(
      (
        await journal.reconcile(
          value.operationId,
          observation(value, { head: newHead, indexHash: value.targetIndex.hash }),
        )
      ).decision,
      'recovery_required',
    );
    assert.deepEqual(
      (await journal.read(value.operationId))?.originalIndex,
      storedImage(value, 'original'),
    );
  });

  test('abandonment persists aborting until lock cleanup and records an idempotent aborted terminal state', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    const prepared = await journal.prepare(value);
    await rejected(journal.transition(transition(value, 1, 'aborted')), 'INVALID_TRANSITION');
    const aborting = await journal.transition(transition(value, 1, 'aborting'));
    assert.equal(aborting.state, 'aborting');
    assert.equal(aborting.revision, 2);
    assert.equal(aborting.recoveryReason, null);
    const restarted = new CommitJournal(data);
    assert.deepEqual(await restarted.read(value.operationId), aborting);
    assert.deepEqual(await restarted.pending(), [aborting]);
    assert.deepEqual(await restarted.prepare(value), aborting);
    assert.deepEqual(await restarted.transition(transition(value, 1, 'aborting')), aborting);
    await rejected(restarted.transition(transition(value, 2, 'ref_updated')), 'INVALID_TRANSITION');
    await rejected(restarted.transition(transition(value, 2, 'completed')), 'INVALID_TRANSITION');
    await rejected(
      restarted.transition({
        ...transition(value, 2, 'aborted'),
        recoveryReason: 'not a recovery',
      }),
      'INVALID_INPUT',
    );
    const aborted = await restarted.transition(transition(value, 2, 'aborted'));
    assert.equal(aborted.state, 'aborted');
    assert.equal(aborted.revision, 3);
    assert.equal(aborted.recoveryReason, null);
    assert.deepEqual(await new CommitJournal(data).read(value.operationId), aborted);
    assert.deepEqual(await restarted.pending(), []);
    assert.deepEqual(await restarted.prepare(value), aborted);
    assert.deepEqual(await restarted.transition(transition(value, 2, 'aborted')), aborted);
    assert.deepEqual(aborted.originalIndex, prepared.originalIndex);
    assert.deepEqual(aborted.targetIndex, prepared.targetIndex);
    for (const next of ['ref_updated', 'completed', 'aborting'] as const)
      await rejected(restarted.transition(transition(value, 3, next)), 'INVALID_TRANSITION');
    await rejected(
      restarted.transition(transition(value, 3, 'recovery_required', 'late')),
      'INVALID_TRANSITION',
    );
  });

  test('aborting remains recoverable and invalid commit-side states cannot enter abandonment', async (t) => {
    const { directory, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    await journal.transition(transition(value, 1, 'aborting'));
    const file = entryPath(directory, value, 2);
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('"state":"aborting"', '"state":"aborted"'));
    await rejected(journal.read(value.operationId), 'CORRUPT');
    assert.match(await readFile(file, 'utf8'), /"state":"aborted"/u);
    await writeFile(file, original);
    const recovery = await journal.transition(
      transition(value, 2, 'recovery_required', 'lock ownership changed'),
    );
    assert.equal(recovery.revision, 3);
    assert.deepEqual(await journal.pending(), [recovery]);
    await rejected(journal.transition(transition(value, 3, 'aborting')), 'INVALID_TRANSITION');
    const advanced = request();
    await journal.prepare(advanced);
    await journal.transition(transition(advanced, 1, 'ref_updated'));
    await rejected(journal.transition(transition(advanced, 2, 'aborting')), 'INVALID_TRANSITION');
    await rejected(journal.transition(transition(advanced, 2, 'aborted')), 'INVALID_TRANSITION');
    await journal.transition(transition(advanced, 2, 'completed'));
    await rejected(journal.transition(transition(advanced, 3, 'aborting')), 'INVALID_TRANSITION');
    await rejected(journal.transition(transition(advanced, 3, 'aborted')), 'INVALID_TRANSITION');
  });

  test('abandonment reconciliation never reports completed and keeps lock cleanup visible', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    const aborting = await journal.transition(transition(value, 1, 'aborting'));
    const restarted = new CommitJournal(data);
    for (const indexLock of [observation(value).indexLock, { state: 'absent' }] as const) {
      assert.equal(
        (await restarted.reconcile(value.operationId, { ...observation(value), indexLock }))
          .decision,
        'aborting',
      );
    }
    for (const changes of [
      { head: newHead, indexHash: value.targetIndex.hash },
      { head: 'd'.repeat(40) },
      { indexHash: 'e'.repeat(64) },
      { indexLock: { state: 'foreign' } },
      { indexLock: { state: 'unknown' } },
      { indexLock: { state: 'owned', operationId: value.operationId, identity: '1:6' } },
    ])
      assert.equal(
        (await restarted.reconcile(value.operationId, { ...observation(value), ...changes }))
          .decision,
        'recovery_required',
      );
    assert.deepEqual(await restarted.read(value.operationId), aborting);
    const aborted = await restarted.transition(transition(value, 2, 'aborted'));
    assert.equal(
      (
        await restarted.reconcile(
          value.operationId,
          observation(value, { indexLock: { state: 'absent' } }),
        )
      ).decision,
      'aborted',
    );
    assert.equal(
      (await restarted.reconcile(value.operationId, observation(value))).decision,
      'recovery_required',
    );
    assert.equal(
      (
        await restarted.reconcile(
          value.operationId,
          observation(value, {
            head: newHead,
            indexHash: value.targetIndex.hash,
            indexLock: { state: 'absent' },
          }),
        )
      ).decision,
      'recovery_required',
    );
    assert.deepEqual(await restarted.read(value.operationId), aborted);
  });

  test('competing commit and abandonment transitions have one durable winner', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    const results = await Promise.allSettled([
      journal.transition(transition(value, 1, 'aborting')),
      new CommitJournal(data).transition(transition(value, 1, 'ref_updated')),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejectedResult = results.find((result) => result.status === 'rejected');
    assert.ok(
      rejectedResult?.status === 'rejected' && rejectedResult.reason instanceof CommitJournalError,
    );
    assert.equal(rejectedResult.reason.code, 'VERSION_CONFLICT');
    const saved = await new CommitJournal(data).read(value.operationId);
    assert.equal(saved?.revision, 2);
    assert.ok(saved?.state === 'aborting' || saved?.state === 'ref_updated');
    assert.deepEqual(await journal.pending(), [saved]);
  });

  test('concurrent identical prepares are idempotent and conflicting prepares have one winner', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    const peers = Array.from({ length: 5 }, () => new CommitJournal(data));
    const records = await Promise.all(peers.map((peer) => peer.prepare(value)));
    for (const record of records) assert.deepEqual(record, records[0]);
    const other = request();
    const results = await Promise.allSettled([
      journal.prepare(other),
      new CommitJournal(data).prepare({ ...other, requestHash: 'e'.repeat(64) }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const loser = results.find((result) => result.status === 'rejected');
    assert.ok(loser?.status === 'rejected' && loser.reason instanceof CommitJournalError);
    assert.equal(loser.reason.code, 'REQUEST_CONFLICT');
    assert.equal(
      (await readdir(join(data, 'commit-journal'))).some((name) => name.startsWith('.pending-')),
      false,
    );
  });

  test('independent processes cannot overwrite a concurrent state transition', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    const moduleUrl = new URL('../server/modules/git/commit-journal.ts', import.meta.url).href;
    const program = `
      const { CommitJournal, CommitJournalError } = await import(process.argv[1]);
      const [data, operationId, requestHash, state] = process.argv.slice(2);
      try {
        await new CommitJournal(data).transition({ operationId, requestHash, expectedRevision: 1, state,
          ...(state === 'recovery_required' ? { recoveryReason: 'fixture interruption' } : {}) });
        process.stdout.write('ok');
      } catch (error) {
        if (!(error instanceof CommitJournalError)) throw error;
        process.stdout.write(error.code);
      }
    `;
    const results = await Promise.all(
      ['ref_updated', 'recovery_required'].map((next) =>
        exec(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          program,
          moduleUrl,
          data,
          value.operationId,
          value.requestHash,
          next,
        ]),
      ),
    );
    assert.deepEqual(results.map((result) => result.stdout).sort(), ['VERSION_CONFLICT', 'ok']);
    const restored = await new CommitJournal(data).read(value.operationId);
    assert.equal(restored?.revision, 2);
    assert.ok(restored?.state === 'ref_updated' || restored?.state === 'recovery_required');
    assert.deepEqual(restored?.originalIndex, storedImage(value, 'original'));
  });

  test('read-only reconciliation handles each crash boundary without changing files or journal state', async (t) => {
    const { root, data, journal } = await fixture(t);
    const value = request();
    const sentinel = join(root, 'index-sentinel');
    await writeFile(sentinel, 'untouched');
    const before = await journal.prepare(value);
    const restored = new CommitJournal(data);
    assert.equal(
      (await restored.reconcile(value.operationId, observation(value))).decision,
      'ready',
    );
    assert.equal(
      (await restored.reconcile(value.operationId, observation(value, { head: newHead }))).decision,
      'publish_index',
    );
    assert.equal(
      (
        await restored.reconcile(
          value.operationId,
          observation(value, { head: newHead, indexHash: value.targetIndex.hash }),
        )
      ).decision,
      'completed',
    );
    for (const changes of [
      { head: 'd'.repeat(40) },
      { indexHash: 'e'.repeat(64) },
      { ref: 'refs/heads/elsewhere' },
      { repositoryId: 'elsewhere' },
      { worktreeIdentity: '2:3' },
      { adminIdentity: '2:4' },
      { indexHash: value.targetIndex.hash },
      { indexLock: { state: 'foreign' } },
      { indexLock: { state: 'unknown' } },
      { indexLock: { state: 'absent' } },
      {
        indexLock: { state: 'owned', operationId: randomUUID(), identity: value.indexLockIdentity },
      },
      { indexLock: { state: 'owned', operationId: value.operationId, identity: '1:6' } },
    ]) {
      const result = await restored.reconcile(value.operationId, {
        ...observation(value),
        ...changes,
      });
      assert.equal(result.decision, 'recovery_required');
    }
    await rejected(
      restored.reconcile(value.operationId, { ...observation(value), extra: true }),
      'INVALID_INPUT',
    );
    await rejected(
      restored.reconcile(value.operationId, {
        ...observation(value),
        indexLock: { state: 'owned' },
      }),
      'INVALID_INPUT',
    );
    assert.deepEqual(await journal.read(value.operationId), before);
    assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
    await journal.transition(transition(value, 1, 'ref_updated'));
    assert.equal(
      (await restored.reconcile(value.operationId, observation(value))).decision,
      'recovery_required',
    );
    assert.equal(
      (await restored.reconcile(value.operationId, observation(value, { head: newHead }))).decision,
      'publish_index',
    );
    assert.equal(
      (
        await restored.reconcile(
          value.operationId,
          observation(value, {
            head: newHead,
            indexHash: value.targetIndex.hash,
            indexLock: { state: 'absent' },
          }),
        )
      ).decision,
      'completed',
    );
  });

  test('owned lock device and inode survive restart and a replacement inode blocks recovery', async (t) => {
    const { root, data, journal } = await fixture(t);
    const lockPath = join(root, 'index.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    const info = await lock.stat({ bigint: true });
    await lock.writeFile('fixture owned lock');
    await lock.close();
    const originalIdentity = info.dev + ':' + info.ino;
    const value = request({ indexLockIdentity: originalIdentity });
    const saved = await journal.prepare(value);
    assert.equal(saved.indexLockIdentity, originalIdentity);
    const restarted = new CommitJournal(data);
    assert.equal((await restarted.read(value.operationId))?.indexLockIdentity, originalIdentity);
    assert.equal(
      (await restarted.reconcile(value.operationId, observation(value))).decision,
      'ready',
    );
    await rename(lockPath, lockPath + '.original');
    const replacement = await open(lockPath, 'wx', 0o600);
    const replaced = await replacement.stat({ bigint: true });
    await replacement.writeFile('fixture external lock');
    await replacement.close();
    const replacementIdentity = replaced.dev + ':' + replaced.ino;
    assert.notEqual(replacementIdentity, originalIdentity);
    assert.equal(
      (
        await restarted.reconcile(
          value.operationId,
          observation(value, {
            indexLock: {
              state: 'owned',
              operationId: value.operationId,
              identity: replacementIdentity,
            },
          }),
        )
      ).decision,
      'recovery_required',
    );
    await rejected(
      journal.prepare({ ...value, indexLockIdentity: replacementIdentity }),
      'REQUEST_CONFLICT',
    );
    assert.equal(await readFile(lockPath, 'utf8'), 'fixture external lock');
    assert.equal((await restarted.read(value.operationId))?.state, 'prepared');
    await rejected(
      restarted.reconcile(value.operationId, {
        ...observation(value),
        indexLock: { state: 'owned', operationId: value.operationId },
      }),
      'INVALID_INPUT',
    );
  });

  test('identical original and target images still permit safe ref publication', async (t) => {
    const { journal } = await fixture(t);
    const value = request();
    value.targetIndex = value.originalIndex;
    await journal.prepare(value);
    assert.equal(
      (await journal.reconcile(value.operationId, observation(value))).decision,
      'ready',
    );
    assert.equal(
      (await journal.reconcile(value.operationId, observation(value, { head: newHead }))).decision,
      'completed',
    );
  });

  test('original and target file references name separate immutable private files across all states', async (t) => {
    const { data, directory, journal } = await fixture(t);
    const value = request();
    // Equal contents still require separate real files for the task repository references.
    value.targetIndex = value.originalIndex;
    const prepared = await journal.prepare(value);
    assert.equal(prepared.originalIndex.file, storedImage(value, 'original').file);
    assert.equal(prepared.targetIndex.file, storedImage(value, 'target').file);
    assert.notEqual(prepared.originalIndex.file, prepared.targetIndex.file);
    const originals = await Promise.all(
      [prepared.originalIndex, prepared.targetIndex].map(async (image) => {
        const path = join(data, image.file);
        const info = await lstat(path, { bigint: true });
        assert.ok(info.isFile());
        assert.equal(info.mode & 0o7777n, 0o600n);
        assert.equal(info.nlink, 1n);
        assert.deepEqual(await readFile(path), image.bytes);
        assert.equal(hashCommitJournalIndex(await readFile(path)), image.hash);
        return info;
      }),
    );
    assert.notEqual(originals[0]?.ino, originals[1]?.ino);
    await journal.transition(transition(value, 1, 'ref_updated'));
    await journal.transition(transition(value, 2, 'completed'));
    const completed = await new CommitJournal(data).read(value.operationId);
    assert.deepEqual(completed?.originalIndex, prepared.originalIndex);
    assert.deepEqual(completed?.targetIndex, prepared.targetIndex);
    for (const [index, image] of [prepared.originalIndex, prepared.targetIndex].entries()) {
      const current = await lstat(join(data, image.file), { bigint: true });
      assert.equal(current.ino, originals[index]?.ino);
      assert.equal(current.mtimeNs, originals[index]?.mtimeNs);
    }
    assert.deepEqual((await readdir(join(directory, value.operationId + '.2'))).sort(), [
      'entry.json',
    ]);
    assert.deepEqual((await readdir(join(directory, value.operationId + '.3'))).sort(), [
      'entry.json',
    ]);
  });

  test('backup file corruption, links, missing files and relaxed permissions block recovery without repair', async (t) => {
    const { data, journal } = await fixture(t);
    const value = request();
    const saved = await journal.prepare(value);
    for (const image of [saved.originalIndex, saved.targetIndex]) {
      const path = join(data, image.file);
      const bytes = await readFile(path);
      await writeFile(path, 'tampered backup');
      await rejected(new CommitJournal(data).read(value.operationId), 'CORRUPT');
      await rejected(journal.transition(transition(value, 1, 'ref_updated')), 'CORRUPT');
      assert.equal(await readFile(path, 'utf8'), 'tampered backup');
      await writeFile(path, bytes);
      await chmod(path, 0o644);
      await rejected(journal.read(value.operationId), 'UNSAFE_PATH');
      await chmod(path, 0o600);
      const linked = join(data, 'fixture-backup-link');
      await link(path, linked);
      await rejected(journal.read(value.operationId), 'UNSAFE_PATH');
      await unlink(linked);
      await unlink(path);
      await rejected(journal.read(value.operationId), 'CORRUPT');
      await writeFile(linked, bytes, { mode: 0o600 });
      await symlink(linked, path);
      await rejected(journal.read(value.operationId), 'UNSAFE_PATH');
      assert.deepEqual(await readFile(linked), bytes);
      await unlink(path);
      await unlink(linked);
      await writeFile(path, bytes, { mode: 0o600 });
    }
    assert.deepEqual(await new CommitJournal(data).read(value.operationId), saved);
  });

  test('created directories and evidence files are strictly private and relaxed permissions are rejected', async (t) => {
    const { data, directory, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
    const folder = join(directory, value.operationId + '.1');
    const file = entryPath(directory, value);
    assert.equal((await lstat(folder)).mode & 0o7777, 0o700);
    assert.equal((await lstat(file)).mode & 0o7777, 0o600);
    for (const [path, unsafe, safe] of [
      [data, 0o755, 0o700],
      [directory, 0o750, 0o700],
      [folder, 0o770, 0o700],
      [file, 0o644, 0o600],
    ] as const) {
      await chmod(path, unsafe);
      await rejected(journal.read(value.operationId), 'UNSAFE_PATH');
      assert.equal((await lstat(path)).mode & 0o7777, unsafe);
      await chmod(path, safe);
    }
    assert.equal((await journal.read(value.operationId))?.state, 'prepared');
  });

  test('path traversal, symlink roots and linked or nonregular records fail without touching targets', async (t) => {
    const { root, data, directory, journal } = await fixture(t);
    const value = request();
    for (const path of ['relative', '/', data + '/../data', data + '/', data + '\0x'])
      assert.throws(() => new CommitJournal(path), { code: 'INVALID_INPUT' });
    const alias = join(root, 'alias');
    await symlink(data, alias);
    await rejected(new CommitJournal(alias).prepare(value), 'UNSAFE_PATH');
    const outside = join(root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, directory);
    await rejected(journal.prepare(value), 'UNSAFE_PATH');
    assert.deepEqual(await readdir(outside), []);
    await unlink(directory);
    await journal.prepare(value);
    const file = entryPath(directory, value);
    const linked = join(outside, 'index');
    await link(file, linked);
    await rejected(journal.read(value.operationId), 'UNSAFE_PATH');
    await unlink(linked);
    const original = await readFile(file);
    await unlink(file);
    await writeFile(linked, original, { mode: 0o600 });
    await symlink(linked, file);
    await rejected(journal.read(value.operationId), 'UNSAFE_PATH');
    assert.deepEqual(await readFile(linked), original);
    await unlink(file);
    await mkdir(file, { mode: 0o700 });
    await rejected(journal.read(value.operationId), 'UNSAFE_PATH');
  });

  test('partial staging directories survive simulated restart and are never mistaken for prepared evidence', async (t) => {
    const { data, directory, journal } = await fixture(t);
    await mkdir(directory, { mode: 0o700 });
    const interrupted = join(directory, '.pending-' + randomUUID());
    await mkdir(interrupted, { mode: 0o700 });
    await writeFile(join(interrupted, 'entry.json'), '{"partial":', { mode: 0o600 });
    const value = request();
    assert.equal(await new CommitJournal(data).read(value.operationId), undefined);
    await journal.prepare(value);
    await journal.transition(transition(value, 1, 'ref_updated'));
    assert.equal((await new CommitJournal(data).read(value.operationId))?.state, 'ref_updated');
    assert.equal(await readFile(join(interrupted, 'entry.json'), 'utf8'), '{"partial":');
    assert.deepEqual(
      (await new CommitJournal(data).pending()).map((record) => record.operationId),
      [value.operationId],
    );
  });

  test('corrupt, noncanonical, mismatched and oversized records are rejected and preserved', async (t) => {
    const { directory, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    const file = entryPath(directory, value);
    const original = await readFile(file, 'utf8');
    const decode = (): Record<string, unknown> => {
      const parsed: unknown = JSON.parse(original);
      assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
      return { ...parsed };
    };
    const badImages = [
      { hash: value.originalIndex.hash, bytes: Buffer.from('tampered').toString('base64') },
      {
        hash: value.originalIndex.hash,
        bytes: value.originalIndex.bytes?.toString('base64') + '\n',
      },
      { hash: null, bytes: value.originalIndex.bytes?.toString('base64') },
    ];
    const corruptions = [
      Buffer.from('{'),
      Buffer.from([255, 254]),
      ...[
        { version: 2 },
        { extra: true },
        { operationId: randomUUID() },
        { revision: 2 },
        { state: 'completed' },
        { commits: [] },
        { indexLockIdentity: 'unverified' },
        { recoveryReason: 'unexpected' },
        ...badImages.map((originalIndex) => ({
          originalIndex: { ...originalIndex, file: storedImage(value, 'original').file },
        })),
        {
          originalIndex: {
            hash: value.originalIndex.hash,
            bytes: value.originalIndex.bytes?.toString('base64'),
            file: '../outside.index',
          },
        },
        {
          targetIndex: {
            hash: value.targetIndex.hash,
            bytes: value.targetIndex.bytes?.toString('base64'),
            file: storedImage(value, 'original').file,
          },
        },
      ].map((change) => Buffer.from(JSON.stringify({ ...decode(), ...change }))),
    ];
    for (const bytes of corruptions) {
      await writeFile(file, bytes);
      await rejected(journal.read(value.operationId), 'CORRUPT');
      await rejected(journal.prepare(value), 'CORRUPT');
      assert.deepEqual(await readFile(file), bytes);
    }
    await truncate(file, 48 * 1024 * 1024);
    await rejected(journal.read(value.operationId), 'CORRUPT');
    await writeFile(file, original);
    assert.equal((await journal.read(value.operationId))?.state, 'prepared');
  });

  test('revision gaps, altered history and unexpected canonical entries cannot be silently repaired', async (t) => {
    const { directory, journal } = await fixture(t);
    const value = request();
    await journal.prepare(value);
    await journal.transition(transition(value, 1, 'ref_updated'));
    const second = entryPath(directory, value, 2);
    const encoded = await readFile(second, 'utf8');
    await writeFile(second, encoded.replace(value.requestHash, 'e'.repeat(64)));
    await rejected(journal.read(value.operationId), 'CORRUPT');
    await writeFile(second, encoded);
    const firstFolder = join(directory, value.operationId + '.1');
    const held = join(directory, '.pending-' + randomUUID());
    await rename(firstFolder, held);
    await rejected(journal.read(value.operationId), 'CORRUPT');
    await rejected(journal.prepare(value), 'CORRUPT');
    await rename(held, firstFolder);
    const unexpected = join(directory, 'unexpected.json');
    await writeFile(unexpected, 'evidence', { mode: 0o600 });
    await rejected(journal.pending(), 'CORRUPT');
    assert.equal(await readFile(unexpected, 'utf8'), 'evidence');
  });

  test('a failed file fsync never publishes a prepared record', async (t) => {
    const { data, journal } = await fixture(t);
    const probe = await open(data, 'r');
    const prototype: Pick<FileHandle, 'sync'> = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    t.mock.method(prototype, 'sync', async function (this: FileHandle) {
      if ((await this.stat()).isFile()) throw new Error('fixture file fsync failure');
      return originalSync.call(this);
    });
    const value = request();
    try {
      await rejected(journal.prepare(value), 'IO_ERROR');
    } finally {
      t.mock.restoreAll();
      await probe.close();
    }
    assert.equal(await new CommitJournal(data).read(value.operationId), undefined);
    assert.equal((await journal.prepare(value)).state, 'prepared');
  });

  test('failure to fsync the target backup prevents publication of the entire prepared operation', async (t) => {
    const { data, directory, journal } = await fixture(t);
    const probe = await open(data, 'r');
    const prototype: Pick<FileHandle, 'sync'> = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    t.mock.method(prototype, 'sync', async function (this: FileHandle) {
      if (
        (await this.stat()).isFile() &&
        (await readlink(`/proc/self/fd/${this.fd}`)).endsWith('/target.index')
      )
        throw new Error('fixture target backup fsync failure');
      return originalSync.call(this);
    });
    const value = request();
    try {
      await rejected(journal.prepare(value), 'IO_ERROR');
    } finally {
      t.mock.restoreAll();
      await probe.close();
    }
    assert.equal(await new CommitJournal(data).read(value.operationId), undefined);
    assert.deepEqual(await readdir(directory), []);
    const retried = await journal.prepare(value);
    assert.deepEqual(
      await readFile(join(data, retried.originalIndex.file)),
      value.originalIndex.bytes,
    );
    assert.deepEqual(await readFile(join(data, retried.targetIndex.file)), value.targetIndex.bytes);
  });

  test('directory fsync failure after publication preserves a complete record for restart and retry', async (t) => {
    const { data, directory, journal } = await fixture(t);
    await mkdir(directory, { mode: 0o700 });
    const value = request();
    const probe = await open(directory, 'r');
    const info = await probe.stat({ bigint: true });
    const prototype: Pick<FileHandle, 'sync'> = Object.getPrototypeOf(probe);
    const originalSync = prototype.sync;
    t.mock.method(prototype, 'sync', async function (this: FileHandle) {
      const current = await this.stat({ bigint: true });
      if (
        current.dev === info.dev &&
        current.ino === info.ino &&
        (await readdir(`/proc/self/fd/${this.fd}`)).includes(value.operationId + '.1')
      )
        throw new Error('fixture directory fsync failure');
      return originalSync.call(this);
    });
    try {
      await rejected(journal.prepare(value), 'IO_ERROR');
    } finally {
      t.mock.restoreAll();
      await probe.close();
    }
    const restarted = new CommitJournal(data);
    const restored = await restarted.read(value.operationId);
    assert.equal(restored?.state, 'prepared');
    assert.deepEqual(restored?.originalIndex, storedImage(value, 'original'));
    assert.deepEqual(await restarted.prepare(value), restored);
  });
});
