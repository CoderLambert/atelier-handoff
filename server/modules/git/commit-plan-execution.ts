/**
 * @file 在已授权的检出租约内执行冻结的多提交计划。
 * @implementation 临时索引构造提交链和目标索引；注入的权威状态协调器先保存恢复证据，再以 Git 协作锁、引用 CAS 和原子重命名发布。
 * @updated 2026-11-27T21:25:00+08:00
 */
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  rename,
  rm,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { gitOid } from '../../../shared/git-workbench.js';
import { AppError } from '../../../shared/errors.js';
import { fingerprint, resolveProjectPath } from '../../files.js';
import {
  hashCommitJournalIndex,
  hashCommitJournalRequest,
  MAX_COMMIT_JOURNAL_INDEX_BYTES,
  type CommitJournalPrepare,
  type CommitJournalRecord,
  type CommitJournalTransition,
} from './commit-journal.js';
import {
  compileCommitPlan,
  type GitCommitPlanCompilation,
  type GitCommitPlanCompiledFile,
} from './commit-plan-compiler.js';
import {
  gitCommitPlanSnapshotSchema,
  readCommitPlanSnapshot,
  type GitCommitPlanSnapshot,
} from './commit-plan-snapshot.js';
import { assertIdleGit } from './development-worktrees.js';
import { fileIdentity, gitError, LocalGit } from './git-cli.js';

/** The host must coordinate its authoritative operation repository AND durable index journal.
 * Methods resolve only after both agree durably. A file journal alone is not business authority.
 * This checkout's scope and request/operation claims are owned by the injected coordinator.
 */
export interface CommitPlanExecutionCoordinator {
  read(operationId: string): Promise<CommitJournalRecord | undefined>;
  unfinished(): Promise<readonly CommitJournalRecord[]>;
  prepare(input: CommitJournalPrepare): Promise<CommitJournalRecord>;
  transition(input: CommitJournalTransition): Promise<CommitJournalRecord>;
}
export type CommitPlanExecutionCheckpoint =
  | 'locked'
  | 'objects_written'
  | 'prepared'
  | 'before_ref_update'
  | 'ref_updated'
  | 'before_index_publish'
  | 'index_published';
export interface CommitPlanExecutionOptions {
  operationId: string;
  coordinator: CommitPlanExecutionCoordinator;
  signal?: AbortSignal;
  /** Fault/race instrumentation. Throws abort execution; production callers normally omit it. */
  checkpoint?(phase: CommitPlanExecutionCheckpoint): Promise<void>;
}
export interface CommitPlanExecutionEvidence {
  operationId: string;
  requestHash: string;
  ref: string;
  oldHead: string | null;
  newHead: string | null;
  commits: readonly string[];
  originalIndexHash: string | null;
  targetIndexHash: string | null;
  indexLock: { path: string; identity: string; retained: boolean } | null;
}
export type CommitPlanExecutionResult =
  | {
      state: 'completed';
      oid: string;
      commits: readonly string[];
      replayed: boolean;
      operation: CommitJournalRecord;
    }
  | {
      state: 'recovery_required';
      reason: string;
      evidence: CommitPlanExecutionEvidence;
      operation: CommitJournalRecord | null;
    };

const errorIs = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;
const sameInode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const inode = (info: BigIntStats) => info.dev + ':' + info.ino;
const stale = () => gitError('PLAN_STALE', '提交计划对应的分支、索引或工作区已变化，请重新核对。');
const durableGitFlags = ['-c', 'core.fsync=all', '-c', 'core.fsyncMethod=fsync'];
const safeIndexFlags = [
  ...durableGitFlags,
  '-c',
  'core.splitIndex=false',
  '-c',
  'index.sparse=false',
];

async function readIndex(path: string): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorIs(error, 'ENOENT')) return null;
    throw gitError('PLAN_INDEX_UNSAFE', 'Git 索引不是可安全读取的普通文件。');
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_COMMIT_JOURNAL_INDEX_BYTES)
    )
      throw gitError('PLAN_INDEX_UNSAFE', 'Git 索引不是受支持的普通文件。');
    // Bound allocation and reads even if a noncooperating writer grows the file after stat.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !sameInode(after, named) ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(bytes.length) !== before.size
    )
      throw stale();
    return bytes;
  } finally {
    await handle.close();
  }
}

async function target(git: LocalGit) {
  const [reference, head] = await Promise.all([
    git.text(['symbolic-ref', '--quiet', 'HEAD'], { allowExit: [1] }),
    git.oid('HEAD'),
  ]);
  return { ref: reference.trim() || 'HEAD', head: head ?? null };
}

async function commitSettings(git: LocalGit) {
  const options = { userCommitConfig: true };
  const signing = await git.text(['config', '--type=bool', '--get', 'commit.gpgSign'], {
    ...options,
    allowExit: [1],
  });
  if (signing.trim() === 'true')
    throw gitError('COMMIT_SIGNING', '当前 Git 配置要求签名，请使用本机 Git 提交。');
  try {
    return await Promise.all(
      ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'].map((key) =>
        git.text(['-c', 'user.useConfigOnly=true', 'var', key], options).then((value) => {
          const identity = /^(\S[^\r\n]*?) <([^<>\s]+)> \d+ [+-]\d{4}\r?\n$/u.exec(value);
          if (!identity) throw gitError('COMMIT_IDENTITY', '请为本机 Git 配置提交者姓名和邮箱。');
          return identity[1] + ' <' + identity[2] + '>';
        }),
      ),
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'GIT_COMMAND_FAILED')
      throw gitError('COMMIT_IDENTITY', '请为本机 Git 配置提交者姓名和邮箱。');
    throw error;
  }
}

async function overlay(
  git: LocalGit,
  indexFile: string,
  files: readonly GitCommitPlanCompiledFile[],
  format: 'sha1' | 'sha256',
) {
  const zero = '0'.repeat(format === 'sha1' ? 40 : 64);
  // Remove first: a file-to-directory transition cannot safely be installed in path sort order.
  const removes: Buffer[] = [];
  const adds: Buffer[] = [];
  for (const file of files) {
    removes.push(Buffer.from('0 ' + zero + '\t' + file.path + '\0'));
    if (file.state.kind === 'missing') continue;
    const state = file.state;
    const bytes = Buffer.from(state.content, state.encoding === 'utf8' ? 'utf8' : 'base64');
    const expected = createHash(format)
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    if (
      !['100644', '100755'].includes(state.mode) ||
      bytes.length !== state.size ||
      fingerprint(bytes) !== state.digest ||
      (state.oid !== null && expected !== state.oid)
    )
      throw gitError('PLAN_INVALID', '编译后的文件内容或模式无效。');
    const oid = gitOid.parse(
      (
        await git.text([...durableGitFlags, 'hash-object', '-w', '--no-filters', '--stdin'], {
          input: bytes,
        })
      ).trim(),
    );
    if (oid !== expected) throw gitError('PLAN_INVALID', 'Git 对象与冻结文件内容不一致。');
    adds.push(Buffer.from(state.mode + ' ' + oid + '\t' + file.path + '\0'));
  }
  if (files.length)
    await git.run([...safeIndexFlags, 'update-index', '-z', '--index-info'], {
      indexFile,
      input: Buffer.concat([...removes, ...adds]),
    });
  return gitOid.parse((await git.text([...safeIndexFlags, 'write-tree'], { indexFile })).trim());
}

function reason(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'GIT_PLAN_CANCELLED';
  return 'GIT_PLAN_EXECUTION_FAILED';
}

/**
 * Preconditions: explicit user confirmation and the host's worktrees.writeCheckout lease.
 * Never writes worktree files. Uses Git's cooperative index.lock protocol: a writer deliberately
 * bypassing that lock can race the final hash check and rename, just as with native Git. Such a
 * hostile writer is outside this contract; observable external changes always stop publication.
 * Recovery is deliberately read/manual at this layer: an existing unfinished operation or unknown
 * lock is never replayed, removed, or guessed to belong to this executor. The coordinator retains
 * exact original/target index images even when a crash leaves index.lock ownership ambiguous.
 */
export async function executeCommitPlan(
  git: LocalGit,
  sourceSnapshot: GitCommitPlanSnapshot,
  suppliedCompilation: GitCommitPlanCompilation,
  options: CommitPlanExecutionOptions,
): Promise<CommitPlanExecutionResult> {
  if (process.platform !== 'linux')
    throw gitError('PLAN_PLATFORM', '当前平台尚未验证多提交索引安全发布。');
  const operationId = z.uuid().parse(options.operationId);
  const snapshot = gitCommitPlanSnapshotSchema.parse(sourceSnapshot);
  const plan = {
    groups: suppliedCompilation.commits.map((commit) => ({
      title: commit.title,
      body: commit.body,
      unitIds: [...commit.unitIds],
    })),
    excludedUnitIds: [...suppliedCompilation.excludedUnitIds],
  };
  // Recompile the selection instead of trusting callers to pass authentic byte overlays.
  const compilation = compileCommitPlan(snapshot, plan);
  if (JSON.stringify(compilation) !== JSON.stringify(suppliedCompilation))
    throw gitError('PLAN_INVALID', '编译结果与冻结快照和分组不一致。');
  if (compilation.commits.length > 120)
    throw gitError('PLAN_LIMIT', '单次多提交数量超过恢复日志上限。');
  const requestHash = hashCommitJournalRequest({ snapshotVersion: snapshot.version, plan });
  const coordinator = options.coordinator;
  const matchesScope = (record: CommitJournalRecord) =>
    record.repositoryId === git.repositoryId &&
    record.worktreeIdentity === snapshot.rootIdentity &&
    record.adminIdentity === snapshot.adminIdentity;
  const existing = await coordinator.read(operationId);
  if (existing && (!matchesScope(existing) || existing.requestHash !== requestHash))
    throw gitError('PLAN_REQUEST_CONFLICT', '该操作标识已属于其他提交请求。');
  const evidence: CommitPlanExecutionEvidence = {
    operationId,
    requestHash,
    ref: snapshot.target.ref,
    oldHead: snapshot.target.head,
    newHead: existing?.newHead ?? null,
    commits: existing?.commits ?? [],
    originalIndexHash: snapshot.index.fingerprint,
    targetIndexHash: existing?.targetIndex.hash ?? null,
    indexLock: null,
  };
  if (existing?.state === 'completed')
    return {
      state: 'completed',
      oid: existing.newHead,
      commits: existing.commits,
      replayed: true,
      operation: existing,
    };
  if (existing)
    return {
      state: 'recovery_required',
      reason: 'GIT_PLAN_UNFINISHED',
      evidence,
      operation: existing,
    };
  if ((await coordinator.unfinished()).some(matchesScope))
    throw gitError('PLAN_UNFINISHED', '此检出有尚未完成恢复的多提交操作。');
  if (snapshot.target.ref === 'HEAD')
    throw gitError('PLAN_DETACHED_HEAD', '分离 HEAD 的引用类型无法安全校验，请先切换到本机分支。');
  options.signal?.throwIfAborted();
  await assertIdleGit(git);
  if (
    git.repositoryId !== snapshot.repositoryId ||
    (await fileIdentity(git.root)) !== snapshot.rootIdentity ||
    (await fileIdentity(git.admin)) !== snapshot.adminIdentity
  )
    throw stale();

  const admin = await open(
    git.admin,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let lock: FileHandle | undefined;
  let lockInfo: BigIntStats | undefined;
  let scratch: string | undefined;
  let retain = false;
  let preparedAttempted = false;
  let record: CommitJournalRecord | undefined;
  let published = false;
  const adminPath = '/proc/self/fd/' + admin.fd;
  const indexPath = join(adminPath, 'index');
  const lockPath = join(adminPath, 'index.lock');
  const namedLockPath = join(git.admin, 'index.lock');
  const adminInfo = await admin.stat({ bigint: true }).catch(async (error: unknown) => {
    await admin.close();
    throw error;
  });
  const checkDirectories = async () => {
    const checkout = await LocalGit.open(git.root);
    if (
      checkout.admin !== git.admin ||
      checkout.repositoryId !== git.repositoryId ||
      checkout.common !== git.common ||
      !sameInode(adminInfo, await lstat(git.admin, { bigint: true })) ||
      (await fileIdentity(git.admin)) !== snapshot.adminIdentity ||
      (await fileIdentity(git.root)) !== snapshot.rootIdentity
    )
      throw stale();
    return checkout;
  };
  const checkLock = async () => {
    if (!lock || !lockInfo) throw gitError('PLAN_LOCK_LOST', '无法确认本次 Git 索引锁归属。');
    const named = await lstat(lockPath, { bigint: true }).catch(() => undefined);
    const opened = await lock.stat({ bigint: true });
    if (
      !named?.isFile() ||
      named.nlink !== 1n ||
      !sameInode(named, lockInfo) ||
      !sameInode(opened, lockInfo)
    )
      throw gitError('PLAN_LOCK_LOST', 'Git 索引锁已被替换，请保留现场恢复。');
    return checkDirectories();
  };
  const checkOriginal = async () => {
    const checkout = await checkLock();
    if (hashCommitJournalIndex(await readIndex(indexPath)) !== snapshot.index.fingerprint)
      throw stale();
    return checkout;
  };
  const checkSnapshot = async () => {
    const checkout = await checkOriginal();
    await assertIdleGit(checkout, true);
    const current = await readCommitPlanSnapshot(checkout, options.signal);
    if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw stale();
    await checkOriginal();
  };
  const worktreeObservation = async () =>
    Promise.all(
      snapshot.files.map(async (file) => {
        const path = join(git.root, file.path);
        const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
          if (errorIs(error, 'ENOENT') || errorIs(error, 'ENOTDIR')) return undefined;
          throw error;
        });
        if (file.worktree.kind === 'missing' && info) throw stale();
        if (file.worktree.kind === 'file') {
          const safePath = await resolveProjectPath(git.root, file.path);
          const bytes = await readIndex(safePath);
          if (
            !bytes ||
            !info?.isFile() ||
            (info.mode & 0o111n ? '100755' : '100644') !== file.worktree.mode ||
            fingerprint(bytes) !== file.worktree.digest
          )
            throw stale();
        }
        return [
          file.path,
          info
            ? [
                String(info.dev),
                String(info.ino),
                String(info.mode),
                String(info.size),
                String(info.mtimeNs),
                String(info.ctimeNs),
              ]
            : null,
        ];
      }),
    );
  const checkpoint = async (phase: CommitPlanExecutionCheckpoint) => {
    options.signal?.throwIfAborted();
    await options.checkpoint?.(phase);
    options.signal?.throwIfAborted();
  };
  try {
    await checkDirectories();
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (errorIs(error, 'EEXIST')) throw gitError('IN_PROGRESS', 'Git 索引正在被其他操作使用。');
      throw error;
    }
    lockInfo = await lock.stat({ bigint: true });
    evidence.indexLock = { path: namedLockPath, identity: inode(lockInfo), retained: false };
    await admin.sync();
    await checkpoint('locked');
    await checkSnapshot();
    // Replace-object interpretation would make the snapshot/tree/parent relationship ambiguous.
    if ((await git.text(['for-each-ref', '--format=%(refname)', 'refs/replace/'])).trim())
      throw gitError('PLAN_UNSAFE_CONFIG', '当前仓库含替换对象，无法安全执行多提交。');
    const identities = await commitSettings(git);
    if ((await git.text(['rev-parse', '--shared-index-path'])).trim())
      throw gitError(
        'PLAN_INDEX_UNSUPPORTED',
        '当前 Git 分离索引尚不支持多提交，请先转换为普通索引。',
      );
    const originalIndex = await readIndex(indexPath);
    if (hashCommitJournalIndex(originalIndex) !== snapshot.index.fingerprint) throw stale();
    scratch = await mkdtemp(join(tmpdir(), 'atelier-commit-plan-'));
    const treeIndex = join(scratch, 'tree-index');
    const targetIndex = join(scratch, 'target-index');
    const commits: string[] = [];
    let parent = snapshot.target.head;
    let previousTree = snapshot.target.tree;
    for (const commit of compilation.commits) {
      options.signal?.throwIfAborted();
      // Every compiler overlay is relative to the ORIGINAL HEAD, including paths reset to baseline.
      await git.run(
        [
          ...safeIndexFlags,
          'read-tree',
          ...(snapshot.target.tree ? [snapshot.target.tree] : ['--empty']),
        ],
        { indexFile: treeIndex },
      );
      const tree = await overlay(git, treeIndex, commit.tree.files, snapshot.objectFormat);
      if (tree === previousTree) throw gitError('COMMIT_EMPTY', '提交分组没有实际变更。');
      const message = commit.title + (commit.body ? '\n\n' + commit.body : '') + '\n';
      const oid = gitOid.parse(
        (
          await git.text(
            [
              ...durableGitFlags,
              '-c',
              'user.useConfigOnly=true',
              'commit-tree',
              '--no-gpg-sign',
              tree,
              ...(parent ? ['-p', parent] : []),
              '-F',
              '-',
            ],
            { userCommitConfig: true, input: Buffer.from(message) },
          )
        ).trim(),
      );
      commits.push(oid);
      parent = oid;
      previousTree = tree;
    }
    if (!parent) throw gitError('COMMIT_EMPTY', '提交计划未生成提交。');
    if (originalIndex) await writeFile(targetIndex, originalIndex, { mode: 0o600, flag: 'wx' });
    // Preserve every untouched entry and index flag. Unresolvable split/sparse indexes fail here,
    // before evidence publication or reference changes, rather than rebuilding a lossy index.
    await overlay(git, targetIndex, compilation.finalIndex.files, snapshot.objectFormat);
    const targetBytes = await readIndex(targetIndex);
    if (!targetBytes) throw gitError('PLAN_INDEX_UNSAFE', '未生成可安全发布的目标索引。');
    evidence.newHead = parent;
    evidence.commits = commits;
    evidence.targetIndexHash = hashCommitJournalIndex(targetBytes);
    await checkpoint('objects_written');
    await checkSnapshot();
    if (JSON.stringify(await commitSettings(git)) !== JSON.stringify(identities))
      throw gitError('COMMIT_IDENTITY', 'Git 提交身份在执行期间发生变化。');
    await lock.writeFile(targetBytes);
    await lock.sync();
    await checkOriginal();
    preparedAttempted = true;
    retain = true;
    record = await coordinator.prepare({
      operationId,
      requestHash,
      repositoryId: git.repositoryId,
      worktreeIdentity: snapshot.rootIdentity,
      adminIdentity: snapshot.adminIdentity,
      indexLockIdentity: inode(lockInfo),
      ref: snapshot.target.ref,
      oldHead: snapshot.target.head,
      newHead: parent,
      commits,
      originalIndex: { hash: snapshot.index.fingerprint, bytes: originalIndex },
      targetIndex: { hash: evidence.targetIndexHash, bytes: targetBytes },
    });
    if (
      record.state !== 'prepared' ||
      record.operationId !== operationId ||
      record.requestHash !== requestHash ||
      record.ref !== snapshot.target.ref ||
      record.oldHead !== snapshot.target.head ||
      record.indexLockIdentity !== inode(lockInfo) ||
      JSON.stringify(record.commits) !== JSON.stringify(commits) ||
      record.newHead !== parent ||
      record.originalIndex.hash !== snapshot.index.fingerprint ||
      record.targetIndex.hash !== evidence.targetIndexHash ||
      !matchesScope(record)
    )
      throw gitError('PLAN_COORDINATION', '提交状态协调器未确认持久化的原始证据。');
    await checkpoint('prepared');
    await checkpoint('before_ref_update');
    await checkSnapshot();
    if (JSON.stringify(await commitSettings(git)) !== JSON.stringify(identities))
      throw gitError('COMMIT_IDENTITY', 'Git 提交身份在执行期间发生变化。');
    const worktreeBeforeRef = JSON.stringify(await worktreeObservation());
    await git.run(
      [
        ...durableGitFlags,
        '-c',
        'user.useConfigOnly=true',
        'update-ref',
        '--no-deref',
        '-m',
        'atelier multi-commit: ' + operationId,
        snapshot.target.ref,
        parent,
        snapshot.target.head ?? '0'.repeat(parent.length),
      ],
      { userCommitConfig: true },
    );
    const advanced = await target(git);
    if (advanced.ref !== snapshot.target.ref || advanced.head !== parent) throw stale();
    record = await coordinator.transition({
      operationId,
      requestHash,
      expectedRevision: record.revision,
      state: 'ref_updated',
    });
    if (record.state !== 'ref_updated')
      throw gitError('PLAN_COORDINATION', '引用推进状态未持久化。');
    await checkpoint('ref_updated');
    await checkpoint('before_index_publish');
    await checkOriginal();
    await assertIdleGit(git, true);
    const currentTarget = await target(git);
    if (currentTarget.ref !== snapshot.target.ref || currentTarget.head !== parent) throw stale();
    const afterRef = await readCommitPlanSnapshot(await checkDirectories(), options.signal);
    const knownPaths = new Set(snapshot.files.map((file) => file.path));
    if (
      afterRef.target.ref !== snapshot.target.ref ||
      afterRef.target.head !== parent ||
      afterRef.index.fingerprint !== snapshot.index.fingerprint ||
      afterRef.configuration !== snapshot.configuration ||
      JSON.stringify(afterRef.ignored) !== JSON.stringify(snapshot.ignored) ||
      afterRef.files.some((file) => !knownPaths.has(file.path)) ||
      JSON.stringify(await worktreeObservation()) !== worktreeBeforeRef
    )
      throw stale();
    await checkOriginal();
    if (hashCommitJournalIndex(await readIndex(lockPath)) !== evidence.targetIndexHash)
      throw gitError('PLAN_LOCK_LOST', 'Git 索引锁内容已变化，请保留现场恢复。');
    // No awaits between the final ownership/hash checks and rename beyond this syscall. Native Git
    // uses the same cooperative lock protocol; the original and target images are already durable.
    await rename(lockPath, indexPath);
    published = true;
    await admin.sync();
    await checkDirectories();
    if (
      !sameInode(lockInfo, await lstat(indexPath, { bigint: true })) ||
      hashCommitJournalIndex(await readIndex(indexPath)) !== evidence.targetIndexHash
    )
      throw stale();
    await checkpoint('index_published');
    record = await coordinator.transition({
      operationId,
      requestHash,
      expectedRevision: record.revision,
      state: 'completed',
    });
    if (record.state !== 'completed') throw gitError('PLAN_COORDINATION', '提交完成状态未持久化。');
    retain = false;
    return { state: 'completed', oid: parent, commits, replayed: false, operation: record };
  } catch (error) {
    if (!preparedAttempted) throw error;
    const code = reason(error);
    // A coordinator failure can itself be an ambiguous successful write: reread before CAS.
    try {
      record = (await coordinator.read(operationId)) ?? record;
      if (record && (record.state === 'prepared' || record.state === 'ref_updated'))
        record = await coordinator.transition({
          operationId,
          requestHash,
          expectedRevision: record.revision,
          state: 'recovery_required',
          recoveryReason: code,
        });
    } catch {
      /* Durable prepared/ref_updated evidence remains; never undo the reference or index. */
    }
    if (evidence.indexLock) {
      const named = await lstat(lockPath, { bigint: true }).catch(() => undefined);
      evidence.indexLock.retained =
        retain && !published && !!lockInfo && !!named && sameInode(named, lockInfo);
    }
    return { state: 'recovery_required', reason: code, evidence, operation: record ?? null };
  } finally {
    // Closing a descriptor never removes a foreign lock. Cleanup uses our pinned directory and inode.
    try {
      if (lock && lockInfo && !retain && !published) {
        const current = await lstat(lockPath, { bigint: true }).catch(() => undefined);
        if (current?.isFile() && sameInode(current, lockInfo)) {
          await unlink(lockPath);
          await admin.sync();
        }
      }
    } finally {
      await lock?.close();
      await admin.close();
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
}
