/**
 * @file 实现以 SQLite 为权威的多提交操作仓储。
 * @implementation 使用短 immediate 事务、唯一约束与带完整作用域的 revision/state CAS，校验版本化提交列表及恢复引用。
 * @updated 2026-11-24T14:57:15+08:00
 */
import { and, asc, eq, gt, notInArray, or } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import {
  canTransitionCommitOperation,
  commitOperationClaim,
  commitOperationPage,
  commitOperationRecord,
  commitOperationScope,
  commitOperationUpdate,
  CommitOperationRepositoryError,
  type CommitOperationClaim,
  type CommitOperationPage,
  type CommitOperationRecord,
  type CommitOperationRepository,
  type CommitOperationScope,
} from '../../modules/git/commit-operation-repository.js';
import { gitCommitOperations as operations } from '../schema/git-commit-operations.js';

const storedCommits = z.strictObject({
  version: z.literal(1),
  oids: commitOperationClaim.shape.commits,
});
function record(row: typeof operations.$inferSelect): CommitOperationRecord {
  const {
    originalIndexFile,
    originalIndexHash,
    targetIndexFile,
    targetIndexHash,
    errorCode,
    ...rest
  } = row;
  return commitOperationRecord.parse({
    ...rest,
    commits: storedCommits.parse(JSON.parse(row.commits)).oids,
    originalIndex:
      originalIndexFile === null && originalIndexHash === null
        ? null
        : { file: originalIndexFile, hash: originalIndexHash },
    targetIndex: { file: targetIndexFile, hash: targetIndexHash },
    error: errorCode === null ? null : { code: errorCode },
  });
}
function inScope(scope: CommitOperationScope) {
  return and(
    eq(operations.projectId, scope.projectId),
    eq(operations.repositoryId, scope.repositoryId),
    eq(operations.worktreeIdentity, scope.worktreeIdentity),
    eq(operations.adminIdentity, scope.adminIdentity),
  );
}
function sameScope(a: CommitOperationScope, b: CommitOperationScope): boolean {
  return (
    a.projectId === b.projectId &&
    a.repositoryId === b.repositoryId &&
    a.worktreeIdentity === b.worktreeIdentity &&
    a.adminIdentity === b.adminIdentity
  );
}
function sameRequest(a: CommitOperationClaim, b: CommitOperationClaim): boolean {
  return (
    sameScope(a, b) &&
    a.requestId === b.requestId &&
    a.requestHash === b.requestHash &&
    a.ref === b.ref &&
    a.oldHead === b.oldHead &&
    a.newHead === b.newHead &&
    JSON.stringify(a.commits) === JSON.stringify(b.commits) &&
    a.originalIndex?.file === b.originalIndex?.file &&
    a.originalIndex?.hash === b.originalIndex?.hash &&
    a.targetIndex.file === b.targetIndex.file &&
    a.targetIndex.hash === b.targetIndex.hash
  );
}
const fail = (code: ConstructorParameters<typeof CommitOperationRepositoryError>[0]): never => {
  throw new CommitOperationRepositoryError(code);
};

export function gitCommitOperationRepository(
  orm: BetterSQLite3Database,
): CommitOperationRepository {
  const get = (
    scope: CommitOperationScope,
    operationId: string,
  ): CommitOperationRecord | undefined => {
    const row = orm
      .select()
      .from(operations)
      .where(and(inScope(scope), eq(operations.operationId, operationId)))
      .get();
    return row && record(row);
  };
  const list = (
    scope: CommitOperationScope | string,
    inputPage: CommitOperationPage = {},
    includeTerminal = false,
  ) => {
    const { limit, after } = commitOperationPage.parse(inputPage);
    return orm
      .select()
      .from(operations)
      .where(
        and(
          typeof scope === 'string' ? eq(operations.projectId, scope) : inScope(scope),
          includeTerminal ? undefined : notInArray(operations.state, ['completed', 'aborted']),
          after
            ? or(
                gt(operations.createdAt, after.createdAt),
                and(
                  eq(operations.createdAt, after.createdAt),
                  gt(operations.operationId, after.operationId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(asc(operations.createdAt), asc(operations.operationId))
      .limit(limit)
      .all()
      .map(record);
  };
  return {
    get(scope, operationId) {
      return get(
        commitOperationScope.parse(scope),
        commitOperationClaim.shape.operationId.parse(operationId),
      );
    },
    findRequest(input, requestId) {
      const scope = commitOperationScope.parse(input);
      const key = commitOperationClaim.shape.requestId.parse(requestId);
      const row = orm
        .select()
        .from(operations)
        .where(and(inScope(scope), eq(operations.requestId, key)))
        .get();
      return row && record(row);
    },
    claim(input) {
      const value = commitOperationClaim.parse(input);
      return orm.transaction(
        (tx) => {
          const byId = tx
            .select()
            .from(operations)
            .where(eq(operations.operationId, value.operationId))
            .get();
          if (byId) {
            if (!sameScope(byId, value)) return fail('REQUEST_CONFLICT');
            const existing = record(byId);
            if (!sameRequest(existing, value)) return fail('REQUEST_CONFLICT');
            return { outcome: 'existing' as const, operation: existing };
          }
          const byRequest = tx
            .select()
            .from(operations)
            .where(and(inScope(value), eq(operations.requestId, value.requestId)))
            .get();
          if (byRequest) {
            const existing = record(byRequest);
            if (!sameRequest(existing, value)) return fail('REQUEST_CONFLICT');
            return { outcome: 'existing' as const, operation: existing };
          }
          const timestamp = new Date().toISOString();
          const { originalIndex, targetIndex, commits, ...fields } = value;
          const row = tx
            .insert(operations)
            .values({
              ...fields,
              state: 'prepared',
              revision: 1,
              commits: JSON.stringify({ version: 1, oids: commits }),
              originalIndexFile: originalIndex?.file ?? null,
              originalIndexHash: originalIndex?.hash ?? null,
              targetIndexFile: targetIndex.file,
              targetIndexHash: targetIndex.hash,
              errorCode: null,
              createdAt: timestamp,
              updatedAt: timestamp,
              finishedAt: null,
            })
            .onConflictDoNothing()
            .returning()
            .get();
          if (!row) return fail('WORKTREE_BUSY');
          return { outcome: 'claimed' as const, operation: record(row) };
        },
        { behavior: 'immediate' },
      );
    },
    listUnfinished(input, inputPage = {}) {
      return list(commitOperationScope.parse(input), inputPage);
    },
    listUnfinishedForProject(projectId, inputPage = {}) {
      return list(commitOperationScope.shape.projectId.parse(projectId), inputPage);
    },
    listForProject(projectId, inputPage = {}) {
      return list(commitOperationScope.shape.projectId.parse(projectId), inputPage, true);
    },
    deleteCompletedForProject(projectId) {
      const id = commitOperationScope.shape.projectId.parse(projectId);
      return orm
        .delete(operations)
        .where(and(eq(operations.projectId, id), eq(operations.state, 'completed')))
        .run().changes;
    },
    deleteAbortedForProject(projectId) {
      const id = commitOperationScope.shape.projectId.parse(projectId);
      return orm
        .delete(operations)
        .where(and(eq(operations.projectId, id), eq(operations.state, 'aborted')))
        .run().changes;
    },
    compareAndSwap(input) {
      const value = commitOperationUpdate.parse(input);
      if (!canTransitionCommitOperation(value.expectedState, value.state))
        return fail('INVALID_TRANSITION');
      return orm.transaction(
        (tx) => {
          const row = tx
            .select()
            .from(operations)
            .where(and(inScope(value.scope), eq(operations.operationId, value.operationId)))
            .get();
          if (!row) return fail('NOT_FOUND');
          const previous = record(row);
          if (previous.requestHash !== value.requestHash) return fail('REQUEST_CONFLICT');
          if (
            previous.revision !== value.expectedRevision ||
            previous.state !== value.expectedState
          )
            return fail('REVISION_CONFLICT');
          const timestamp = new Date(
            Math.max(Date.now(), Date.parse(previous.updatedAt)),
          ).toISOString();
          const updated = tx
            .update(operations)
            .set({
              revision: value.expectedRevision + 1,
              state: value.state,
              errorCode: value.error?.code ?? null,
              updatedAt: timestamp,
              finishedAt:
                value.state === 'completed' || value.state === 'aborted' ? timestamp : null,
            })
            .where(
              and(
                inScope(value.scope),
                eq(operations.operationId, value.operationId),
                eq(operations.requestHash, value.requestHash),
                eq(operations.revision, value.expectedRevision),
                eq(operations.state, value.expectedState),
              ),
            )
            .returning()
            .get();
          if (!updated) return fail('REVISION_CONFLICT');
          return record(updated);
        },
        { behavior: 'immediate' },
      );
    },
  };
}
