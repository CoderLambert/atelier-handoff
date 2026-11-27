/**
 * @file 定义多提交恢复日志的数据契约、哈希规范与状态迁移规则。
 * @implementation 提供纯数据结构校验、确定性请求摘要与版本化状态推进判定，不包含磁盘 I/O。
 * @updated 2026-11-27T12:18:00-06:00
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_MULTI_COMMIT_GROUPS } from '../../../shared/git-multi-commit.js';

export const MAX_COMMIT_JOURNAL_INDEX_BYTES = 16 * 1024 * 1024;
export const maxRecordBytes = 2 * Math.ceil(MAX_COMMIT_JOURNAL_INDEX_BYTES / 3) * 4 + 64 * 1024;
export const id = z.uuid().refine((value) => value === value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const oid = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
  .refine((value) => /[1-9a-f]/u.test(value));
const identity = z.string().min(1).max(8192);
const indexLockIdentity = z
  .string()
  .refine(
    (value) =>
      /^(?:0|[1-9][0-9]{0,19}):[1-9][0-9]{0,19}$/u.test(value) &&
      value.split(':').every((part) => BigInt(part) <= 18_446_744_073_709_551_615n),
  );
const ref = z
  .string()
  .max(1024)
  .refine((value) => {
    if (value === 'HEAD') return true;
    if (!value.startsWith('refs/heads/')) return false;
    const name = value.slice('refs/heads/'.length);
    return (
      name.length > 0 &&
      !name.startsWith('-') &&
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
const state = z.enum([
  'prepared',
  'ref_updated',
  'completed',
  'recovery_required',
  'aborting',
  'aborted',
]);
export type CommitJournalState = z.infer<typeof state>;
export type CommitJournalErrorCode =
  | 'INVALID_INPUT'
  | 'UNSAFE_PATH'
  | 'CORRUPT'
  | 'NOT_FOUND'
  | 'REQUEST_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'IO_ERROR'
  | 'UNSUPPORTED_PLATFORM';

export class CommitJournalError extends Error {
  constructor(
    readonly code: CommitJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CommitJournalError';
  }
}
export const failure = (code: CommitJournalErrorCode, message: string): never => {
  throw new CommitJournalError(code, message);
};
export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Hashes exact index bytes; null represents a missing index, distinct from an empty file. */
export function hashCommitJournalIndex(bytes: Buffer | null): string | null {
  if (bytes === null) return null;
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_COMMIT_JOURNAL_INDEX_BYTES)
    return failure('INVALID_INPUT', 'Invalid or oversized index image.');
  return digest(bytes);
}

/** A deterministic digest of JSON data, rejecting lossy JSON conversions, getters and cycles. */
export function hashCommitJournalRequest(request: unknown): string {
  const ancestors = new Set<object>();
  let entries = 0;
  const canonical = (value: unknown, depth: number): string => {
    if (++entries > 100_000 || depth > 64)
      return failure('INVALID_INPUT', 'Request is too complex.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
      return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (typeof value !== 'object' || value === null || ancestors.has(value))
      return failure('INVALID_INPUT', 'Request must be JSON data without cycles.');
    if (
      (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      Object.getOwnPropertySymbols(value).length
    )
      return failure('INVALID_INPUT', 'Request must contain plain JSON objects.');
    ancestors.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).filter(
        (key) => !(Array.isArray(value) && key === 'length'),
      );
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          return failure('INVALID_INPUT', 'Request properties must be ordinary JSON values.');
      }
      if (Array.isArray(value)) {
        if (keys.length !== value.length || keys.some((key, index) => key !== String(index)))
          return failure('INVALID_INPUT', 'Sparse or extended arrays are not JSON requests.');
        return (
          '[' + keys.map((key) => canonical(descriptors[key]?.value, depth + 1)).join(',') + ']'
        );
      }
      return (
        '{' +
        keys
          .sort()
          .map((key) => JSON.stringify(key) + ':' + canonical(descriptors[key]?.value, depth + 1))
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(value);
    }
  };
  const encoded = canonical(request, 0);
  if (Buffer.byteLength(encoded) > 1024 * 1024)
    return failure('INVALID_INPUT', 'Request is too large.');
  return digest(encoded);
}

const indexImage = z
  .strictObject({
    hash: hash.nullable(),
    bytes: z.instanceof(Buffer).nullable(),
  })
  .refine((value) =>
    value.bytes === null
      ? value.hash === null
      : value.bytes.length <= MAX_COMMIT_JOURNAL_INDEX_BYTES && value.hash === digest(value.bytes),
  );
const encodedImage = z
  .strictObject({
    hash: hash.nullable(),
    bytes: z
      .string()
      .max(Math.ceil(MAX_COMMIT_JOURNAL_INDEX_BYTES / 3) * 4)
      .nullable(),
    file: z.string().min(1).max(160),
  })
  .transform((value, context): z.infer<typeof indexImage> & { file: string } => {
    const bytes = value.bytes === null ? null : Buffer.from(value.bytes, 'base64');
    if (
      (bytes !== null && bytes.toString('base64') !== value.bytes) ||
      !indexImage.safeParse({ hash: value.hash, bytes }).success
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid index backup or digest.' });
      return z.NEVER;
    }
    return { hash: value.hash, bytes, file: value.file };
  });
export const backupPath = (operationId: string, kind: 'original' | 'target') =>
  `commit-journal/${operationId}.1/${kind}.index`;
const requestFields = {
  operationId: id,
  requestHash: hash,
  owner: z.strictObject({ projectId: id, requestDigest: hash }).optional(),
  repositoryId: identity,
  worktreeIdentity: identity,
  adminIdentity: identity,
  indexLockIdentity,
  ref,
  oldHead: oid.nullable(),
  newHead: oid,
  commits: z
    .array(oid)
    .min(1)
    .max(MAX_MULTI_COMMIT_GROUPS)
    .refine((values) => new Set(values).size === values.length),
};
const validHeads = (value: {
  oldHead: string | null;
  newHead: string;
  ref: string;
  commits: string[];
}) =>
  value.oldHead !== value.newHead &&
  (value.oldHead === null ? value.ref !== 'HEAD' : value.oldHead.length === value.newHead.length) &&
  value.commits.at(-1) === value.newHead &&
  value.commits.every(
    (commit) => commit.length === value.newHead.length && commit !== value.oldHead,
  );
export const prepareSchema = z
  .strictObject({
    ...requestFields,
    originalIndex: indexImage,
    targetIndex: indexImage,
  })
  .refine(validHeads);
export type CommitJournalPrepare = z.infer<typeof prepareSchema>;
export const recordSchema = z
  .strictObject({
    ...requestFields,
    originalIndex: encodedImage,
    targetIndex: encodedImage,
    version: z.literal(1),
    revision: z.int().min(1).max(3),
    state,
    recoveryReason: z.string().trim().min(1).max(1024).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine(validHeads)
  .refine(
    (value) =>
      (value.state === 'recovery_required') === (value.recoveryReason !== null) &&
      (value.revision === 1) === (value.state === 'prepared') &&
      Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
      value.originalIndex.file === backupPath(value.operationId, 'original') &&
      value.targetIndex.file === backupPath(value.operationId, 'target'),
  );
export type CommitJournalRecord = z.infer<typeof recordSchema>;
export const transitionSchema = z
  .strictObject({
    operationId: id,
    requestHash: hash,
    expectedRevision: z.int().min(1).max(3),
    state: z.enum(['ref_updated', 'completed', 'recovery_required', 'aborting', 'aborted']),
    recoveryReason: z.string().trim().min(1).max(1024).optional(),
  })
  .refine(
    (value) => (value.state === 'recovery_required') === (value.recoveryReason !== undefined),
  );
export type CommitJournalTransition = z.infer<typeof transitionSchema>;
export const observationSchema = z.strictObject({
  repositoryId: identity,
  worktreeIdentity: identity,
  adminIdentity: identity,
  ref,
  head: oid.nullable(),
  indexHash: hash.nullable(),
  indexLock: z.union([
    z.strictObject({ state: z.literal('owned'), operationId: id, identity: indexLockIdentity }),
    z.strictObject({ state: z.enum(['absent', 'foreign', 'unknown']) }),
  ]),
});
export type CommitJournalObservation = z.infer<typeof observationSchema>;
export interface CommitJournalReconciliation {
  operation: CommitJournalRecord;
  decision: 'ready' | 'publish_index' | 'completed' | 'recovery_required' | 'aborting' | 'aborted';
  reason: string;
}
export function parse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: CommitJournalErrorCode = 'INVALID_INPUT',
): T {
  const result = schema.safeParse(input);
  if (!result.success) return failure(code, 'Commit journal validation failed.');
  return result.data;
}
export function encode(value: CommitJournalPrepare | CommitJournalRecord): string {
  return JSON.stringify({
    ...value,
    originalIndex: {
      hash: value.originalIndex.hash,
      bytes: value.originalIndex.bytes?.toString('base64') ?? null,
      ...('file' in value.originalIndex ? { file: value.originalIndex.file } : {}),
    },
    targetIndex: {
      hash: value.targetIndex.hash,
      bytes: value.targetIndex.bytes?.toString('base64') ?? null,
      ...('file' in value.targetIndex ? { file: value.targetIndex.file } : {}),
    },
  });
}
export function requestKey(value: CommitJournalPrepare | CommitJournalRecord): string {
  return encode(
    parse(
      prepareSchema,
      {
        operationId: value.operationId,
        requestHash: value.requestHash,
        owner: value.owner,
        repositoryId: value.repositoryId,
        worktreeIdentity: value.worktreeIdentity,
        adminIdentity: value.adminIdentity,
        indexLockIdentity: value.indexLockIdentity,
        ref: value.ref,
        oldHead: value.oldHead,
        newHead: value.newHead,
        commits: value.commits,
        originalIndex: { hash: value.originalIndex.hash, bytes: value.originalIndex.bytes },
        targetIndex: { hash: value.targetIndex.hash, bytes: value.targetIndex.bytes },
      },
      'CORRUPT',
    ),
  );
}
export function validTransition(previous: CommitJournalState, next: CommitJournalState): boolean {
  return (
    (previous === 'prepared' &&
      (next === 'ref_updated' || next === 'recovery_required' || next === 'aborting')) ||
    (previous === 'ref_updated' && (next === 'completed' || next === 'recovery_required')) ||
    (previous === 'aborting' && (next === 'aborted' || next === 'recovery_required'))
  );
}

/** True when `next` is one legal non-recovery journal revision ahead of `previous`. */
export function isLegalJournalAdvance(
  previous: { state: CommitJournalState; revision: number },
  next: { state: CommitJournalState; revision: number },
): boolean {
  return (
    next.revision === previous.revision + 1 &&
    next.state !== 'recovery_required' &&
    validTransition(previous.state, next.state)
  );
}
