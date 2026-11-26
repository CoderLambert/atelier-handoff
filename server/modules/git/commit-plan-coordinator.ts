/**
 * @file 协调多提交任务状态与私有索引恢复证据。
 * @implementation SQLite 持有项目范围的操作状态，文件日志持有校验过的索引备份；两者不一致时停止并要求恢复。
 * @updated 2026-11-24T14:41:22+08:00
 */
import type { Store } from '../../store.js';
import {
  CommitJournal,
  type CommitJournalObservation,
  type CommitJournalRecord,
  type CommitJournalState,
} from './commit-journal.js';
import type { CommitPlanExecutionCoordinator } from './commit-plan-execution.js';
import {
  hashCommitRepositoryIdentity,
  type CommitOperationRecord,
  type CommitOperationScope,
} from './commit-operation-repository.js';
import { gitError } from './git-cli.js';

const recovery = () =>
  gitError('PLAN_RECOVERY_REQUIRED', '提交状态或索引恢复证据不一致，请先核对。');
const conflict = () => gitError('PLAN_REQUEST_CONFLICT', '操作编号已属于另一份提交计划。');

export interface CommitPlanRecoveryCoordinator extends CommitPlanExecutionCoordinator {
  adoptOrphan(operationId: string): Promise<CommitJournalRecord>;
  readAllowAhead(operationId: string): Promise<
    | {
        operation: CommitJournalRecord;
        authority: { state: CommitJournalState; revision: number };
      }
    | undefined
  >;
  reconcileAhead(input: {
    operationId: string;
    requestHash: string;
    expectedState: CommitJournalState;
    expectedRevision: number;
    journalRevision: number;
    observation: CommitJournalObservation;
    indexIdentity: string | null;
  }): Promise<CommitJournalRecord>;
}

/** One coordinator is scoped to an already authorized checkout and one user-confirmed digest. */
export function commitPlanCoordinator(
  store: Pick<Store, 'gitCommitOperations'>,
  journal: CommitJournal,
  projectId: string,
  repositoryId: string,
  worktreeIdentity: string,
  adminIdentity: string,
  requestDigest: string,
): CommitPlanRecoveryCoordinator {
  const scope: CommitOperationScope = {
    projectId,
    repositoryId: hashCommitRepositoryIdentity(repositoryId),
    worktreeIdentity,
    adminIdentity,
  };
  const belongs = (record: CommitJournalRecord) =>
    record.repositoryId === repositoryId &&
    record.worktreeIdentity === worktreeIdentity &&
    record.adminIdentity === adminIdentity;
  const sameEvidence = (record: CommitOperationRecord, evidence: CommitJournalRecord) =>
    record.operationId === evidence.operationId &&
    (!evidence.owner ||
      (evidence.owner.projectId === projectId &&
        evidence.owner.requestDigest === record.requestHash)) &&
    record.ref === evidence.ref &&
    record.oldHead === evidence.oldHead &&
    record.newHead === evidence.newHead &&
    JSON.stringify(record.commits) === JSON.stringify(evidence.commits) &&
    record.originalIndex?.hash === (evidence.originalIndex.hash ?? undefined) &&
    record.targetIndex.hash === evidence.targetIndex.hash &&
    record.targetIndex.file === evidence.targetIndex.file &&
    (record.originalIndex?.file ?? null) ===
      (evidence.originalIndex.hash === null ? null : evidence.originalIndex.file);
  const agrees = (record: CommitOperationRecord, evidence: CommitJournalRecord) =>
    sameEvidence(record, evidence) &&
    record.state === evidence.state &&
    record.revision === evidence.revision;
  const ahead = (record: CommitOperationRecord, evidence: CommitJournalRecord) =>
    evidence.revision === record.revision + 1 &&
    ((record.state === 'prepared' && ['ref_updated', 'aborting'].includes(evidence.state)) ||
      (record.state === 'ref_updated' && evidence.state === 'completed') ||
      (record.state === 'aborting' && evidence.state === 'aborted'));
  return {
    async adoptOrphan(operationId) {
      const existing = store.gitCommitOperations.get(scope, operationId);
      const evidence = await journal.read(operationId);
      if (
        !evidence ||
        !belongs(evidence) ||
        evidence.state !== 'prepared' ||
        evidence.owner?.projectId !== projectId ||
        evidence.owner.requestDigest !== requestDigest ||
        !evidence.targetIndex.hash
      )
        throw recovery();
      if (existing) {
        if (existing.requestHash !== requestDigest || !agrees(existing, evidence)) throw recovery();
        return evidence;
      }
      const result = store.gitCommitOperations.claim({
        ...scope,
        operationId,
        requestId: operationId,
        requestHash: requestDigest,
        ref: evidence.ref,
        oldHead: evidence.oldHead,
        newHead: evidence.newHead,
        commits: evidence.commits,
        originalIndex: evidence.originalIndex.hash
          ? { file: evidence.originalIndex.file, hash: evidence.originalIndex.hash }
          : null,
        targetIndex: { file: evidence.targetIndex.file, hash: evidence.targetIndex.hash },
      });
      if (!agrees(result.operation, evidence)) throw recovery();
      return evidence;
    },
    async readAllowAhead(operationId) {
      const record = store.gitCommitOperations.get(scope, operationId);
      const evidence = await journal.read(operationId);
      if (!record && !evidence) return undefined;
      if (record && record.requestHash !== requestDigest) throw conflict();
      if (!record || !evidence || !belongs(evidence) || !sameEvidence(record, evidence))
        throw recovery();
      if (!agrees(record, evidence) && !ahead(record, evidence)) throw recovery();
      return { operation: evidence, authority: { state: record.state, revision: record.revision } };
    },
    async reconcileAhead(input) {
      const record = store.gitCommitOperations.get(scope, input.operationId);
      const evidence = await journal.read(input.operationId);
      if (!record || !evidence || !belongs(evidence) || !sameEvidence(record, evidence))
        throw recovery();
      if (
        record.requestHash !== requestDigest ||
        evidence.requestHash !== input.requestHash ||
        record.state !== input.expectedState ||
        record.revision !== input.expectedRevision ||
        evidence.revision !== input.journalRevision ||
        !ahead(record, evidence)
      )
        throw recovery();
      const observed = await journal.reconcile(input.operationId, input.observation);
      if (
        observed.operation.revision !== evidence.revision ||
        observed.operation.state !== evidence.state
      )
        throw recovery();
      const lock = input.observation.indexLock;
      const ownsLock =
        lock.state === 'owned' &&
        lock.operationId === input.operationId &&
        lock.identity === evidence.indexLockIdentity;
      const accepted =
        evidence.state === 'ref_updated'
          ? (observed.decision === 'publish_index' || observed.decision === 'completed') &&
            ownsLock &&
            input.indexIdentity !== evidence.indexLockIdentity
          : evidence.state === 'completed'
            ? observed.decision === 'completed' &&
              input.indexIdentity === evidence.indexLockIdentity &&
              lock.state === 'absent'
            : evidence.state === 'aborting'
              ? observed.decision === 'aborting' && ownsLock
              : evidence.state === 'aborted' &&
                observed.decision === 'aborted' &&
                lock.state === 'absent';
      if (!accepted || evidence.state === 'prepared') throw recovery();
      const next = store.gitCommitOperations.compareAndSwap({
        scope,
        operationId: input.operationId,
        requestHash: requestDigest,
        expectedState: record.state,
        expectedRevision: record.revision,
        state: evidence.state,
        error: null,
      });
      if (!agrees(next, evidence)) throw recovery();
      return evidence;
    },
    async read(operationId) {
      const record = store.gitCommitOperations.get(scope, operationId);
      const evidence = await journal.read(operationId);
      if (!record && !evidence) return undefined;
      if (record && record.requestHash !== requestDigest) throw conflict();
      if (!record || !evidence || !belongs(evidence) || !agrees(record, evidence)) throw recovery();
      return evidence;
    },
    async unfinished() {
      const records = store.gitCommitOperations.listUnfinished(scope, { limit: 200 });
      const evidence = (await journal.pending()).filter(belongs);
      if (records.length !== evidence.length) throw recovery();
      for (const record of records) {
        const matching = evidence.find((entry) => entry.operationId === record.operationId);
        if (!matching || !agrees(record, matching)) throw recovery();
      }
      return evidence;
    },
    async prepare(input) {
      if (
        input.repositoryId !== repositoryId ||
        input.worktreeIdentity !== worktreeIdentity ||
        input.adminIdentity !== adminIdentity
      )
        throw conflict();
      // File evidence must reach stable storage before the authoritative database points at it.
      const evidence = await journal.prepare({
        ...input,
        owner: { projectId, requestDigest },
      });
      if (!evidence.targetIndex.hash) throw recovery();
      const result = store.gitCommitOperations.claim({
        ...scope,
        operationId: input.operationId,
        requestId: input.operationId,
        requestHash: requestDigest,
        ref: input.ref,
        oldHead: input.oldHead,
        newHead: input.newHead,
        commits: input.commits,
        originalIndex: evidence.originalIndex.hash
          ? { file: evidence.originalIndex.file, hash: evidence.originalIndex.hash }
          : null,
        targetIndex: { file: evidence.targetIndex.file, hash: evidence.targetIndex.hash },
      });
      if (!agrees(result.operation, evidence)) throw recovery();
      return evidence;
    },
    async transition(input) {
      const current = store.gitCommitOperations.get(scope, input.operationId);
      if (!current || current.requestHash !== requestDigest) throw recovery();
      const evidence = await journal.transition(input);
      const next = store.gitCommitOperations.compareAndSwap({
        scope,
        operationId: input.operationId,
        requestHash: requestDigest,
        expectedRevision: input.expectedRevision,
        expectedState: current.state,
        state: input.state,
        error: input.state === 'recovery_required' ? { code: 'GIT_PLAN_RECOVERY_REQUIRED' } : null,
      });
      if (!agrees(next, evidence)) throw recovery();
      return evidence;
    },
  };
}
