/**
 * @file 按持久证据恢复已推进引用的多提交操作，或安全放弃尚未推进引用的操作。
 * @implementation 在外层授权与检出租约内对账日志、权威状态、目录、HEAD、索引和锁身份；恢复时仅发布经确认的自有索引，放弃时仅移除经确认的自有锁，证据不一致时保留现场。
 * @updated 2026-11-27T21:40:00+08:00
 */
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import {
  hashCommitJournalIndex,
  isLegalJournalAdvance,
  MAX_COMMIT_JOURNAL_INDEX_BYTES,
  type CommitJournal,
  type CommitJournalObservation,
  type CommitJournalRecord,
  type CommitJournalState,
} from './commit-journal.js';
import type { CommitPlanExecutionCoordinator } from './commit-plan-execution.js';
import { assertIdleGit } from './development-worktrees.js';
import { fileIdentity, gitError, LocalGit } from './git-cli.js';
import {
  errnoIs as errorIs,
  OPEN_DIRECTORY_FLAGS,
  readHeadTarget,
  readRegularFileSafely,
  statIdentity as identity,
  verifyCheckoutDirectories,
} from './git-safe-io.js';

export interface CommitPlanRecoveryAhead {
  operation: CommitJournalRecord;
  authority: { state: CommitJournalState; revision: number };
}
export interface CommitPlanRecoveryAheadRequest {
  operationId: string;
  requestHash: string;
  expectedState: CommitJournalState;
  expectedRevision: number;
  journalRevision: number;
  observation: CommitJournalObservation;
  indexIdentity: string | null;
}
export type CommitPlanRecoveryCoordinator = Pick<
  CommitPlanExecutionCoordinator,
  'read' | 'transition'
> & {
  /** Read only. Must verify scope/request and ALL frozen evidence agree; only one legal edge may lag. */
  readAllowAhead?(operationId: string): Promise<CommitPlanRecoveryAhead | undefined>;
  /** After physical Git validation, CAS only the lagging authority; never rewrites journal evidence. */
  reconcileAhead?(input: CommitPlanRecoveryAheadRequest): Promise<CommitJournalRecord>;
};
export type CommitPlanRecoveryCheckpoint =
  | 'observed'
  | 'ref_updated'
  | 'before_index_publish'
  | 'index_published'
  | 'aborting'
  | 'before_lock_remove'
  | 'lock_removed';
export interface CommitPlanRecoveryOptions {
  operationId: string;
  journal: Pick<CommitJournal, 'read' | 'reconcile'>;
  /** Must verify the authoritative operation repository and journal agree, as in execution. */
  coordinator: CommitPlanRecoveryCoordinator;
  signal?: AbortSignal;
  checkpoint?(phase: CommitPlanRecoveryCheckpoint): Promise<void>;
}
export interface CommitPlanRecoveryEvidence {
  ref: string | null;
  head: string | null;
  indexHash: string | null;
  indexIdentity: string | null;
  indexLock: { state: 'absent' | 'owned' | 'foreign' | 'unknown'; identity: string | null };
}
export type CommitPlanRecoveryResult =
  | {
      state: 'completed';
      operationId: string;
      oid: string;
      commits: readonly string[];
      indexPublished: boolean;
      replayed: boolean;
    }
  | {
      state: 'recovery_required';
      operationId: string;
      reason: string;
      evidence: CommitPlanRecoveryEvidence;
    };

export type CommitPlanAbandonResult =
  | { state: 'aborted'; operationId: string; lockRemoved: boolean; replayed: boolean }
  | Extract<CommitPlanRecoveryResult, { state: 'recovery_required' }>;

const blocked = (code: string): never => {
  throw gitError('PLAN_RECOVERY_' + code, '提交恢复证据不一致，请保留现场并核对。');
};
const sameFrozen = (a: CommitJournalRecord, b: CommitJournalRecord) =>
  JSON.stringify([
    a.operationId,
    a.requestHash,
    a.owner?.projectId ?? null,
    a.owner?.requestDigest ?? null,
    a.repositoryId,
    a.worktreeIdentity,
    a.adminIdentity,
    a.indexLockIdentity,
    a.ref,
    a.oldHead,
    a.newHead,
    a.commits,
    a.originalIndex.hash,
    a.originalIndex.file,
    a.targetIndex.hash,
    a.targetIndex.file,
    a.version,
    a.createdAt,
  ]) ===
  JSON.stringify([
    b.operationId,
    b.requestHash,
    b.owner?.projectId ?? null,
    b.owner?.requestDigest ?? null,
    b.repositoryId,
    b.worktreeIdentity,
    b.adminIdentity,
    b.indexLockIdentity,
    b.ref,
    b.oldHead,
    b.newHead,
    b.commits,
    b.originalIndex.hash,
    b.originalIndex.file,
    b.targetIndex.hash,
    b.targetIndex.file,
    b.version,
    b.createdAt,
  ]);
const sameState = (a: CommitJournalRecord, b: CommitJournalRecord) =>
  sameFrozen(a, b) &&
  a.state === b.state &&
  a.revision === b.revision &&
  a.recoveryReason === b.recoveryReason &&
  a.updatedAt === b.updatedAt;

interface Image {
  hash: string;
  identity: string;
}
async function image(path: string): Promise<Image | null> {
  const result = await readRegularFileSafely(path, {
    maxBytes: MAX_COMMIT_JOURNAL_INDEX_BYTES,
  });
  if (result.status === 'missing') return null;
  if (result.status === 'changed' || (result.status === 'unsafe' && result.reason === 'replaced'))
    return blocked('FILE_CHANGED');
  if (result.status === 'unsafe') return blocked('UNSAFE_FILE');
  const hash = hashCommitJournalIndex(result.bytes);
  if (!hash) return blocked('UNSAFE_FILE');
  return { hash, identity: identity(result.stat) };
}

/** Requires explicit recovery authorization and an already held worktrees.writeCheckout lease.
 * Publishes only a proven owned index; never updates refs, resets files, or removes a lock.
 * Native Git's cooperative lock assumptions apply. Receipts never expose index bytes.
 */
export function recoverCommitPlan(
  git: LocalGit,
  options: CommitPlanRecoveryOptions,
): Promise<CommitPlanRecoveryResult> {
  return settleCommitPlan(git, options, 'recover');
}

/** Requires a separate explicit user abandon action and the checkout write lease.
 * Persists aborting BEFORE removing the verified owned lock, fsyncs, then persists aborted.
 * An aborting retry with no lock may finish only while the original HEAD/ref/index still match.
 * Never resets files, changes refs, or reports a successful commit. Foreign locks stay untouched.
 */
export function abandonCommitPlan(
  git: LocalGit,
  options: CommitPlanRecoveryOptions,
): Promise<CommitPlanAbandonResult> {
  return settleCommitPlan(git, options, 'abandon');
}

function settleCommitPlan(
  git: LocalGit,
  options: CommitPlanRecoveryOptions,
  action: 'recover',
): Promise<CommitPlanRecoveryResult>;
function settleCommitPlan(
  git: LocalGit,
  options: CommitPlanRecoveryOptions,
  action: 'abandon',
): Promise<CommitPlanAbandonResult>;
async function settleCommitPlan(
  git: LocalGit,
  options: CommitPlanRecoveryOptions,
  action: 'recover' | 'abandon',
): Promise<CommitPlanRecoveryResult | CommitPlanAbandonResult> {
  const evidence: CommitPlanRecoveryEvidence = {
    ref: null,
    head: null,
    indexHash: null,
    indexIdentity: null,
    indexLock: { state: 'unknown', identity: null },
  };
  let admin: FileHandle | undefined;
  let record: CommitJournalRecord | undefined;
  let didPublish = false;
  let didRemove = false;
  let pendingAhead: CommitPlanRecoveryAhead | undefined;
  const operationId = options.operationId;
  const checkpoint = async (phase: CommitPlanRecoveryCheckpoint) => {
    options.signal?.throwIfAborted();
    await options.checkpoint?.(phase);
    options.signal?.throwIfAborted();
  };
  const readAgreed = async (expected?: CommitJournalRecord) => {
    const journal = await options.journal.read(operationId);
    const candidate = options.coordinator.readAllowAhead
      ? await options.coordinator.readAllowAhead(operationId)
      : undefined;
    const authoritative = options.coordinator.readAllowAhead
      ? candidate?.operation
      : await options.coordinator.read(operationId);
    if (!journal || !authoritative) return blocked('MISSING_STATE');
    pendingAhead = undefined;
    if (
      candidate &&
      (candidate.authority.state !== journal.state ||
        candidate.authority.revision !== journal.revision)
    ) {
      if (
        !options.coordinator.reconcileAhead ||
        !isLegalJournalAdvance(candidate.authority, journal)
      )
        return blocked('STATE_MISMATCH');
      pendingAhead = candidate;
    }
    if (
      journal.operationId !== operationId ||
      !sameState(journal, authoritative) ||
      (expected && !sameState(journal, expected))
    )
      return blocked('STATE_MISMATCH');
    if (journal.state === 'recovery_required') return blocked('BLOCKED_STATE');
    if (action === 'abandon' && !['prepared', 'aborting', 'aborted'].includes(journal.state))
      return blocked('ABANDON_UNSAFE_STATE');
    if (action === 'recover' && ['aborting', 'aborted'].includes(journal.state))
      return blocked('ABANDONED_STATE');
    if (
      journal.repositoryId !== git.repositoryId ||
      journal.targetIndex.hash === null ||
      journal.targetIndex.bytes === null ||
      hashCommitJournalIndex(journal.targetIndex.bytes) !== journal.targetIndex.hash ||
      hashCommitJournalIndex(journal.originalIndex.bytes) !== journal.originalIndex.hash
    )
      return blocked('EVIDENCE_MISMATCH');
    return journal;
  };
  const repairAhead = async (
    expected: CommitJournalRecord,
    observation: CommitJournalObservation,
  ) => {
    const pending = pendingAhead;
    if (!pending) return;
    if (!options.coordinator.reconcileAhead || !sameState(pending.operation, expected))
      return blocked('STATE_MISMATCH');
    const aligned = await options.coordinator.reconcileAhead({
      operationId,
      requestHash: expected.requestHash,
      expectedState: pending.authority.state,
      expectedRevision: pending.authority.revision,
      journalRevision: expected.revision,
      observation,
      indexIdentity: evidence.indexIdentity,
    });
    if (!sameState(aligned, expected)) return blocked('STATE_MISMATCH');
    await readAgreed(expected);
    if (pendingAhead) return blocked('STATE_MISMATCH');
  };
  try {
    if (process.platform !== 'linux') return blocked('PLATFORM');
    if (!z.uuid().safeParse(operationId).success) return blocked('INVALID_ID');
    options.signal?.throwIfAborted();
    record = await readAgreed();
    const originalRecord = record;
    const replayed = record.state === (action === 'abandon' ? 'aborted' : 'completed');
    admin = await open(git.admin, OPEN_DIRECTORY_FLAGS);
    const adminInfo = await admin.stat({ bigint: true });
    const directory = '/proc/self/fd/' + admin.fd;
    const indexPath = join(directory, 'index');
    const lockPath = join(directory, 'index.lock');
    const checkDirectories = async () => {
      const current = await verifyCheckoutDirectories(
        git,
        {
          repositoryId: originalRecord.repositoryId,
          rootIdentity: originalRecord.worktreeIdentity,
          adminIdentity: originalRecord.adminIdentity,
          adminInfo,
          expectedCommon: git.common,
        },
        options.signal,
      );
      if (!current) return blocked('CHECKOUT_CHANGED');
      return current;
    };
    const observe = async (): Promise<CommitJournalObservation> => {
      const current = await checkDirectories();
      const [{ ref: headRef, head }, index] = await Promise.all([
        readHeadTarget(current, options.signal),
        image(indexPath),
      ]);
      evidence.ref = headRef;
      evidence.head = head;
      evidence.indexHash = index?.hash ?? null;
      evidence.indexIdentity = index?.identity ?? null;
      const namedLock = await lstat(lockPath, { bigint: true }).catch((error: unknown) => {
        if (errorIs(error, 'ENOENT')) return undefined;
        throw error;
      });
      let indexLock: CommitJournalObservation['indexLock'];
      if (!namedLock) {
        indexLock = { state: 'absent' };
        evidence.indexLock = { state: 'absent', identity: null };
      } else if (
        !namedLock.isFile() ||
        namedLock.nlink !== 1n ||
        identity(namedLock) !== originalRecord.indexLockIdentity ||
        !process.geteuid ||
        namedLock.uid !== BigInt(process.geteuid()) ||
        (namedLock.mode & 0o7777n) !== 0o600n
      ) {
        indexLock = { state: 'foreign' };
        evidence.indexLock = { state: 'foreign', identity: identity(namedLock) };
      } else {
        const locked = await image(lockPath);
        if (
          !locked ||
          locked.identity !== originalRecord.indexLockIdentity ||
          locked.hash !== originalRecord.targetIndex.hash
        ) {
          indexLock = { state: 'unknown' };
          evidence.indexLock = { state: 'unknown', identity: locked?.identity ?? null };
        } else {
          indexLock = { state: 'owned', operationId, identity: locked.identity };
          evidence.indexLock = { state: 'owned', identity: locked.identity };
        }
      }
      await assertIdleGit(current, indexLock.state === 'owned');
      return {
        repositoryId: current.repositoryId,
        worktreeIdentity: await fileIdentity(git.root),
        adminIdentity: await fileIdentity(git.admin),
        ref: evidence.ref,
        head: evidence.head,
        indexHash: evidence.indexHash,
        indexLock,
      };
    };
    const classify = async (expected: CommitJournalRecord) => {
      await readAgreed(expected);
      const observed = await observe();
      const decision = await options.journal.reconcile(operationId, observed);
      if (!sameState(decision.operation, expected)) return blocked('STATE_MISMATCH');
      if (action === 'abandon') {
        if (
          !['ready', 'aborting', 'aborted'].includes(decision.decision) ||
          observed.ref !== expected.ref ||
          observed.head !== expected.oldHead ||
          observed.indexHash !== expected.originalIndex.hash
        )
          return blocked('ABANDON_OBSERVATION_MISMATCH');
        const owned = observed.indexLock.state === 'owned';
        const absent = observed.indexLock.state === 'absent';
        if (!(
          (expected.state === 'prepared' && owned) ||
          (expected.state === 'aborting' && (owned || absent)) ||
          (expected.state === 'aborted' && absent)
        ))
          return blocked('ABANDON_LOCK_CHANGED');
        await repairAhead(expected, observed);
        return owned ? ('owned' as const) : ('absent' as const);
      }
      if (
        decision.decision === 'recovery_required' ||
        decision.decision === 'ready' ||
        observed.head !== expected.newHead ||
        observed.ref !== expected.ref
      )
        return blocked(decision.decision === 'ready' ? 'REF_NOT_UPDATED' : 'OBSERVATION_MISMATCH');
      // Hash equality alone cannot prove rename, especially when original and target bytes match.
      const published =
        observed.indexHash === expected.targetIndex.hash &&
        evidence.indexIdentity === expected.indexLockIdentity &&
        observed.indexLock.state === 'absent';
      const publishable =
        observed.indexHash === expected.originalIndex.hash &&
        observed.indexLock.state === 'owned' &&
        expected.state !== 'completed';
      if (!published && !publishable) return blocked('INDEX_OR_LOCK_CHANGED');
      await repairAhead(expected, observed);
      return published ? ('published' as const) : ('publishable' as const);
    };
    const advance = async (state: 'ref_updated' | 'completed' | 'aborting' | 'aborted') => {
      if (!record) return blocked('MISSING_STATE');
      await readAgreed(record);
      const next = await options.coordinator.transition({
        operationId,
        requestHash: record.requestHash,
        expectedRevision: record.revision,
        state,
      });
      if (
        !sameFrozen(originalRecord, next) ||
        next.state !== state ||
        next.revision !== record.revision + 1
      )
        return blocked('STATE_MISMATCH');
      record = await readAgreed(next);
    };
    await classify(record);
    await checkpoint('observed');
    if (action === 'abandon') {
      if (record.state === 'prepared') {
        await classify(record);
        await advance('aborting');
        await checkpoint('aborting');
      }
      if (record.state === 'aborting') {
        await checkpoint('before_lock_remove');
        const lock = await classify(record);
        if (lock === 'owned') {
          await checkDirectories();
          // Cooperative Git lock ownership, dev:inode and exact target bytes were just verified.
          await unlink(lockPath);
          didRemove = true;
          evidence.indexLock = { state: 'absent', identity: null };
        } else if (lock !== 'absent') return blocked('ABANDON_LOCK_CHANGED');
        // Also sync on a retry: a previous process may have died after unlink but before fsync.
        await admin.sync();
        await checkpoint('lock_removed');
        if ((await classify(record)) !== 'absent') return blocked('ABANDON_LOCK_CHANGED');
        await advance('aborted');
      }
      if (record.state !== 'aborted' || (await classify(record)) !== 'absent')
        return blocked('ABANDON_OBSERVATION_MISMATCH');
      return { state: 'aborted', operationId, lockRemoved: didRemove, replayed };
    }
    if (record.state === 'prepared') {
      // The actual new HEAD has already been verified; this only catches up the durable receipt.
      await classify(record);
      await advance('ref_updated');
      await checkpoint('ref_updated');
    }
    const classification = await classify(record);
    if (classification === 'publishable') {
      await checkpoint('before_index_publish');
      if ((await classify(record)) !== 'publishable') return blocked('OBSERVATION_MISMATCH');
      await checkDirectories();
      // Standard Git cooperative lock publication. No foreign lock is unlinked or replaced.
      await rename(lockPath, indexPath);
      didPublish = true;
      evidence.indexHash = record.targetIndex.hash;
      evidence.indexIdentity = record.indexLockIdentity;
      evidence.indexLock = { state: 'absent', identity: null };
      await admin.sync();
      await checkpoint('index_published');
      if ((await classify(record)) !== 'published') return blocked('OBSERVATION_MISMATCH');
    }
    if (record.state === 'ref_updated') {
      await classify(record);
      await advance('completed');
    }
    if ((await classify(record)) !== 'published' || record.state !== 'completed')
      return blocked('OBSERVATION_MISMATCH');
    return {
      state: 'completed',
      operationId,
      oid: record.newHead,
      commits: [...record.commits],
      indexPublished: didPublish,
      replayed,
    };
  } catch (error) {
    const reason =
      error instanceof AppError
        ? error.code
        : error instanceof Error && error.name === 'AbortError'
          ? 'GIT_PLAN_RECOVERY_CANCELLED'
          : 'GIT_PLAN_RECOVERY_FAILED';
    return { state: 'recovery_required', operationId, reason, evidence };
  } finally {
    await admin?.close();
  }
}
