/**
 * @file 定义多提交操作的权威状态、恢复引用与作用域仓储接口。
 * @implementation 校验冻结证据和状态转换；仅保存私有文件引用及校验值，授权与 Git/文件执行由用例负责。
 * @updated 2026-11-27T21:40:00+08:00
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_MULTI_COMMIT_GROUPS } from '../../../shared/git-multi-commit.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[^\x00-\x1f\x7f]+$/u);
const oid = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
  .refine((value) => /[1-9a-f]/u.test(value));
const ref = z
  .string()
  .max(1024)
  .refine((value) => {
    if (value === 'HEAD') return true;
    return (
      value.startsWith('refs/heads/') &&
      value.length > 'refs/heads/'.length &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !/[\x00-\x20\x7f~^:?*[\]\\]/u.test(value) &&
      value
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            !part.startsWith('.') &&
            !part.endsWith('.') &&
            !part.endsWith('.lock'),
        )
    );
  });

/** Convert LocalGit.repositoryId (canonical common path + NUL + inode identity) once at the caller boundary. */
export function hashCommitRepositoryIdentity(repositoryId: string): string {
  const value = z.string().min(1).max(8192).parse(repositoryId);
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const commitOperationScope = z.strictObject({
  projectId: uuid,
  repositoryId: hash,
  worktreeIdentity: identity,
  adminIdentity: identity,
});
export type CommitOperationScope = z.infer<typeof commitOperationScope>;

/** Opaque private-root-relative file reference. The file module verifies ownership and bytes. */
export const commitIndexReference = z.strictObject({
  file: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_.\/-]+$/u)
    .refine((value) =>
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    ),
  hash,
});
export type CommitIndexReference = z.infer<typeof commitIndexReference>;
export const commitOperationState = z.enum([
  'prepared',
  'ref_updated',
  'aborting',
  'completed',
  'aborted',
  'recovery_required',
]);
export type CommitOperationState = z.infer<typeof commitOperationState>;
// Persist stable error codes, never raw exceptions, process output, file contents or credentials.
export const commitOperationError = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u),
});
const frozenFields = {
  ...commitOperationScope.shape,
  operationId: uuid,
  requestId: uuid,
  requestHash: hash,
  ref,
  oldHead: oid.nullable(),
  newHead: oid,
  commits: z.array(oid).min(1).max(MAX_MULTI_COMMIT_GROUPS),
  originalIndex: commitIndexReference.nullable(),
  targetIndex: commitIndexReference,
};
const validEvidence = (value: {
  oldHead: string | null;
  newHead: string;
  ref: string;
  commits: string[];
  originalIndex: CommitIndexReference | null;
  targetIndex: CommitIndexReference;
}) =>
  value.oldHead !== value.newHead &&
  (value.oldHead !== null || value.ref !== 'HEAD') &&
  (value.oldHead === null || value.oldHead.length === value.newHead.length) &&
  value.commits.at(-1) === value.newHead &&
  new Set(value.commits).size === value.commits.length &&
  value.commits.every((item) => item.length === value.newHead.length && item !== value.oldHead) &&
  value.originalIndex?.file !== value.targetIndex.file;
export const commitOperationClaim = z.strictObject(frozenFields).refine(validEvidence);
export type CommitOperationClaim = z.infer<typeof commitOperationClaim>;
export const commitOperationRecord = z
  .strictObject({
    ...frozenFields,
    state: commitOperationState,
    revision: z.int().min(1).max(3),
    error: commitOperationError.nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .refine(validEvidence)
  .refine(
    (value) =>
      (value.state === 'prepared'
        ? value.revision === 1
        : value.state === 'ref_updated' || value.state === 'aborting'
          ? value.revision === 2
          : value.state === 'completed' || value.state === 'aborted'
            ? value.revision === 3
            : value.revision >= 2) &&
      (value.state === 'recovery_required') === (value.error !== null) &&
      (value.state === 'completed' || value.state === 'aborted') === (value.finishedAt !== null) &&
      value.updatedAt >= value.createdAt &&
      (value.finishedAt === null || value.finishedAt === value.updatedAt),
  );
export type CommitOperationRecord = z.infer<typeof commitOperationRecord>;
export const commitOperationUpdate = z
  .strictObject({
    scope: commitOperationScope,
    operationId: uuid,
    requestHash: hash,
    expectedRevision: z.int().min(1).max(3),
    expectedState: commitOperationState,
    state: commitOperationState.exclude(['prepared']),
    error: commitOperationError.nullable().default(null),
  })
  .refine((value) => (value.state === 'recovery_required') === (value.error !== null));
export type CommitOperationUpdate = z.input<typeof commitOperationUpdate>;
export const commitOperationPage = z.strictObject({
  limit: z.int().min(1).max(200).default(100),
  after: z.strictObject({ createdAt: z.iso.datetime(), operationId: uuid }).optional(),
});
export type CommitOperationPage = z.input<typeof commitOperationPage>;

export type CommitOperationRepositoryErrorCode =
  'NOT_FOUND' | 'REQUEST_CONFLICT' | 'REVISION_CONFLICT' | 'INVALID_TRANSITION' | 'WORKTREE_BUSY';
export class CommitOperationRepositoryError extends Error {
  constructor(readonly code: CommitOperationRepositoryErrorCode) {
    super(code);
    this.name = 'CommitOperationRepositoryError';
  }
}
export function canTransitionCommitOperation(
  from: CommitOperationState,
  to: CommitOperationState,
): boolean {
  return (
    (from === 'prepared' &&
      (to === 'ref_updated' || to === 'aborting' || to === 'recovery_required')) ||
    (from === 'ref_updated' && (to === 'completed' || to === 'recovery_required')) ||
    (from === 'aborting' && (to === 'aborted' || to === 'recovery_required'))
  );
}

/** All methods require a previously authorized, freshly observed scope; none grants Git authority.
 * recovery_required remains unfinished and blocks new claims in that checkout until manual recovery.
 * CAS never silently replays: a stale revision requires rereading, even when the new state matches.
 */
export interface CommitOperationRepository {
  claim(input: CommitOperationClaim): {
    outcome: 'claimed' | 'existing';
    operation: CommitOperationRecord;
  };
  get(scope: CommitOperationScope, operationId: string): CommitOperationRecord | undefined;
  findRequest(scope: CommitOperationScope, requestId: string): CommitOperationRecord | undefined;
  listUnfinished(scope: CommitOperationScope, page?: CommitOperationPage): CommitOperationRecord[];
  /** Startup recovery enumerates authorized project evidence even when a checkout has disappeared. */
  listUnfinishedForProject(projectId: string, page?: CommitOperationPage): CommitOperationRecord[];
  /** Data migration verifies completed evidence as well as unfinished operations. */
  listForProject(projectId: string, page?: CommitOperationPage): CommitOperationRecord[];
  /** Authorized project deletion may discard only completed receipts in its own transaction. */
  deleteCompletedForProject(projectId: string): number;
  /** Explicitly discarded operations are non-success terminal evidence, cleaned separately. */
  deleteAbortedForProject(projectId: string): number;
  compareAndSwap(input: CommitOperationUpdate): CommitOperationRecord;
}
