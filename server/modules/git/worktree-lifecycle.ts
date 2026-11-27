/**
 * @file 编排开发工作树的回收、恢复与启动对账流程。
 * @implementation 复用幂等骨架、快照校验与临时目录清理，安全推进工作树回收、快照恢复和中断恢复。
 * @updated 2026-11-27T12:45:00-06:00
 */
import type {
  GitRestoreRequest,
  GitRetentionReason,
  GitSessionWorkspace,
} from '../../../shared/git-workbench.js';
import type { Project, Session } from '../../../shared/types.js';
import { now } from '../../../shared/errors.js';
import { fingerprint } from '../../files.js';
import type { Store } from '../../store.js';
import { fileIdentity, gitError, LocalGit } from './git-cli.js';
import { captureCheckout, type WorktreeSnapshots } from './worktree-snapshots.js';
import type { WorktreeLeaseManager } from './worktree-lease-manager.js';
import type { WorktreeOperation, WorktreeRecord } from './worktree-repository.js';
import {
  assertIdleGit,
  checkWorktreeCheckout,
  discardScratchWorktree,
  needsRestoreBranch,
  openWorktreeRepository,
  pathExists,
  retentionReason,
  returnParkedWorktree,
  scratchPath,
  worktreePath,
} from './worktree-guards.js';

export interface WorktreeLifecycleContext {
  readonly store: Store;
  readonly managed: string;
  readonly snapshots: WorktreeSnapshots;
  readonly leaseManager: WorktreeLeaseManager;
  readonly dependencies: {
    inUse(path: string): boolean;
    closeDirectory(path: string): Promise<void>;
  };
  runIdempotentWorktreeOp<T>(options: {
    requestId: string;
    requestHash: string;
    allowFailedReplay?: boolean;
    onReplay: (prior: WorktreeOperation) => Promise<T> | T;
    prepareTarget: () => Promise<{ git: LocalGit; path: string }>;
    execute: (target: { git: LocalGit; path: string }) => Promise<T>;
  }): Promise<T>;
  checkManaged(path: string): Promise<void>;
  owned(project: Project, id: string): WorktreeRecord;
  allArchived(row: WorktreeRecord): boolean;
  state(project: Project, row: WorktreeRecord): Promise<GitSessionWorkspace>;
  finish(row: WorktreeRecord, operation: WorktreeOperation): void;
  fail(
    row: WorktreeRecord,
    operation: WorktreeOperation,
    error: unknown,
    reason?: GitRetentionReason,
  ): void;
  completeCreate(
    project: Project,
    row: WorktreeRecord,
    operation: WorktreeOperation,
  ): Promise<Session>;
}

async function scratchCheckout(
  ctx: WorktreeLifecycleContext,
  git: LocalGit,
  path: string,
  oid: string,
): Promise<LocalGit> {
  await ctx.checkManaged(path);
  if (await pathExists(path)) throw gitError('DESTINATION_EXISTS', '临时检出目录已存在。');
  await git.run(['worktree', 'add', '--detach', '--', path, oid]);
  return LocalGit.open(path);
}

export async function reclaimWorktree(
  ctx: WorktreeLifecycleContext,
  project: Project,
  id: string,
  requestId: string,
): Promise<GitSessionWorkspace> {
  const existing = ctx.owned(project, id);
  const requestHash = fingerprint(JSON.stringify([project.id, 'reclaim', id]));
  await ctx.runIdempotentWorktreeOp({
    requestId,
    requestHash,
    allowFailedReplay: true,
    onReplay: () => undefined,
    prepareTarget: async () => ({
      git: await openWorktreeRepository(project, existing),
      path: worktreePath(ctx.managed, project, existing),
    }),
    execute: async ({ git: source, path }) => {
      if (ctx.leaseManager.hasTerminalReservation(path))
        throw gitError('DIRECTORY_BUSY', '工作目录仍有未结束的终端。');
      let row = ctx.owned(project, id);
      if (row.retained === 'relocated' || !row.directoryIdentity || !ctx.allArchived(row))
        throw gitError('DIRECTORY_BUSY', '所有关联会话均归档后才能回收工作树。');
      await ctx.checkManaged(path);
      const { git, entry } = await checkWorktreeCheckout(row, path);
      if (!entry.head) throw gitError('BASE_MISSING', '工作树没有可保存的基线提交。');
      let operation: WorktreeOperation = {
        id: requestId,
        worktreeId: id,
        requestHash,
        kind: 'reclaim',
        state: 'pending',
        sessionId: null,
        branch: row.branch,
        oid: entry.head,
        createdAt: now(),
        finishedAt: null,
        scratchIdentity: null,
        error: null,
      };
      ctx.store.gitWorktrees.saveOperation(operation);
      const verifyPath = scratchPath(ctx.managed, 'verify', operation.id);
      const quarantine = scratchPath(ctx.managed, 'reclaim', operation.id);
      let moved = false;
      try {
        if (entry.locked || ctx.dependencies.inUse(path))
          throw gitError('DIRECTORY_BUSY', '工作树已锁定或有待处理的任务。');
        await assertIdleGit(git);
        await ctx.dependencies.closeDirectory(path);
        const capture = await captureCheckout(git, row.branch, row.rebuildable);
        if (capture.manifest.oid !== operation.oid)
          throw gitError('WORKTREE_CHANGED', '工作树基线在保存期间变化。');
        const snapshotDigest = await ctx.snapshots.save(operation.id, capture);
        const manifest = await ctx.snapshots.manifest(operation.id, snapshotDigest);
        const verification = await scratchCheckout(ctx, source, verifyPath, operation.oid);
        operation = { ...operation, scratchIdentity: await fileIdentity(verifyPath) };
        ctx.store.gitWorktrees.saveOperation(operation);
        try {
          await ctx.snapshots.apply(operation.id, verification, manifest);
          await ctx.snapshots.verify(verification, manifest);
        } finally {
          await discardScratchWorktree(source, verifyPath, operation.scratchIdentity);
        }
        // Keep the base reachable even if the original branch is later reset or deleted.
        await source.run(['update-ref', 'refs/atelier/snapshots/' + operation.id, operation.oid]);
        await ctx.snapshots.verify(
          (await checkWorktreeCheckout(row, path)).git,
          manifest,
          row.rebuildable,
        );
        if (await pathExists(quarantine))
          throw gitError('DESTINATION_EXISTS', '回收暂存目录已存在。');
        row = { ...row, snapshotId: operation.id, snapshotDigest };
        ctx.store.gitWorktrees.saveWorktree(row);
        await source.run(['worktree', 'move', '--', path, quarantine]);
        moved = true;
        const parked = await checkWorktreeCheckout(row, quarantine);
        await ctx.snapshots.verify(parked.git, manifest, row.rebuildable);
        await assertIdleGit((await checkWorktreeCheckout(row, quarantine)).git);
        // Destructive removal only targets the private, verified directory.
        await source.run(['worktree', 'remove', '--force', '--', quarantine]);
        ctx.store.transaction(() =>
          ctx.finish(
            { ...row, directoryIdentity: null, adminIdentity: null, retained: null },
            operation,
          ),
        );
      } catch (error) {
        const parked = moved || (row.snapshotId === operation.id && (await pathExists(quarantine)));
        let reason = retentionReason(error);
        if (parked) {
          if (
            !(await pathExists(quarantine)) &&
            !(await pathExists(path)) &&
            row.snapshotId === operation.id
          ) {
            ctx.store.transaction(() =>
              ctx.finish(
                { ...row, directoryIdentity: null, adminIdentity: null, retained: null },
                operation,
              ),
            );
            return;
          }
          const recovered = await returnParkedWorktree(
            ctx.managed,
            project,
            source,
            row,
            quarantine,
          );
          if (!recovered) reason = 'relocated';
        }
        const retained =
          reason === 'relocated' ? row : { ...row, snapshotId: null, snapshotDigest: null };
        ctx.fail(retained, operation, error, reason);
      }
    },
  });
  return ctx.state(project, ctx.owned(project, id));
}

export async function completeRestoreWorktree(
  ctx: WorktreeLifecycleContext,
  project: Project,
  row: WorktreeRecord,
  operation: WorktreeOperation,
): Promise<Session> {
  if (!row.snapshotId || !row.snapshotDigest || !operation.sessionId)
    throw gitError('RESTORE_UNAVAILABLE', '恢复记录缺少快照或会话。');
  const restored = {
    ...row,
    branch: operation.branch,
    directoryIdentity: null,
    adminIdentity: null,
  };
  const manifest = await ctx.snapshots.manifest(row.snapshotId, row.snapshotDigest);
  const { git, entry, identity, admin } = await checkWorktreeCheckout(
    restored,
    worktreePath(ctx.managed, project, restored),
  );
  if (
    identity !== operation.scratchIdentity ||
    entry.head !== operation.oid ||
    manifest.oid !== operation.oid
  )
    throw gitError('WORKTREE_CHANGED', '恢复目录的基线已变化。');
  await ctx.snapshots.verify(git, manifest);
  const session = ctx.store.get('sessions', operation.sessionId);
  return ctx.store.transaction(() => {
    ctx.finish(
      {
        ...restored,
        directoryIdentity: identity,
        adminIdentity: admin,
        snapshotId: null,
        snapshotDigest: null,
        retained: null,
      },
      operation,
    );
    const active = ctx.store.update('sessions', session.id, {
      status: 'active',
      updatedAt: now(),
    });
    ctx.store.event('session-' + session.id, session.id, 'session.updated', {
      worktreeId: row.id,
    });
    return active;
  });
}

export async function restoreWorktree(
  ctx: WorktreeLifecycleContext,
  session: Session,
  input: GitRestoreRequest,
): Promise<Session> {
  const row = ctx.store.gitWorktrees.forSession(session.id);
  if (!row || row.mode !== 'linked')
    throw gitError('WORKTREE_MISSING', '此会话没有可恢复的工作树。', 404);
  const project = ctx.store.get('projects', session.projectId);
  const requestHash = fingerprint(
    JSON.stringify([project.id, 'restore', session.id, input.branch]),
  );
  return ctx.runIdempotentWorktreeOp({
    requestId: input.requestId,
    requestHash,
    onReplay: () => ctx.store.get('sessions', session.id),
    prepareTarget: async () => ({
      git: await openWorktreeRepository(project, row),
      path: worktreePath(ctx.managed, project, row),
    }),
    execute: async ({ git: source, path }) => {
      const current = ctx.owned(project, row.id);
      if (
        !current.snapshotId ||
        !current.snapshotDigest ||
        current.retained === 'relocated' ||
        (await pathExists(path))
      )
        throw gitError('RESTORE_UNAVAILABLE', '原目录已存在或没有可用的工作树快照。');
      await ctx.checkManaged(path);
      const manifest = await ctx.snapshots.manifest(current.snapshotId, current.snapshotDigest);
      const pin = await source.oid('refs/atelier/snapshots/' + current.snapshotId);
      if (pin !== manifest.oid) throw gitError('SNAPSHOT_CORRUPT', '快照基线不可用或校验失败。');
      if (
        (!input.branch || input.branch === manifest.branch) &&
        (await needsRestoreBranch(source, manifest.branch, manifest.oid))
      )
        throw gitError('RESTORE_BRANCH_REQUIRED', '原分支已移动或被占用，请确认一个新分支名。');
      const branch = input.branch ?? manifest.branch;
      if (branch !== manifest.branch) await source.checkNewBranch(branch);
      let operation: WorktreeOperation = {
        id: input.requestId,
        worktreeId: row.id,
        requestHash,
        kind: 'restore',
        state: 'pending',
        sessionId: session.id,
        branch,
        oid: manifest.oid,
        createdAt: now(),
        finishedAt: null,
        scratchIdentity: null,
        error: null,
      };
      ctx.store.gitWorktrees.saveOperation(operation);
      const staging = scratchPath(ctx.managed, 'restore', operation.id);
      try {
        const scratch = await scratchCheckout(ctx, source, staging, manifest.oid);
        operation = { ...operation, scratchIdentity: await fileIdentity(staging) };
        ctx.store.gitWorktrees.saveOperation(operation);
        await ctx.snapshots.apply(current.snapshotId, scratch, manifest);
        await scratch.run([
          'switch',
          '--no-guess',
          '--no-overwrite-ignore',
          ...(branch === manifest.branch ? [branch] : ['-c', branch]),
        ]);
        await ctx.snapshots.verify(scratch, manifest);
        if (await pathExists(path)) throw gitError('DESTINATION_EXISTS', '原工作目录已被占用。');
        await source.run(['worktree', 'move', '--', staging, path]);
        return await completeRestoreWorktree(ctx, project, current, operation);
      } catch (error) {
        try {
          await discardScratchWorktree(source, staging, operation.scratchIdentity);
        } catch {
          // Keep a private checkout that cannot be removed by Git.
        }
        ctx.fail(current, operation, error, 'snapshotFailed');
        throw error;
      }
    },
  });
}

async function recoverReclaimWorktree(
  ctx: WorktreeLifecycleContext,
  project: Project,
  row: WorktreeRecord,
  operation: WorktreeOperation,
): Promise<void> {
  const git = await openWorktreeRepository(project, row);
  await discardScratchWorktree(
    git,
    scratchPath(ctx.managed, 'verify', operation.id),
    operation.scratchIdentity,
  );
  if (row.snapshotId !== operation.id || !row.snapshotDigest)
    throw gitError('OPERATION_FAILED', '归档在快照验证前中断。');
  const manifest = await ctx.snapshots.manifest(operation.id, row.snapshotDigest);
  const parked = scratchPath(ctx.managed, 'reclaim', operation.id);
  if (await pathExists(parked)) {
    const returned = await returnParkedWorktree(ctx.managed, project, git, row, parked);
    const retained = returned ? { ...row, snapshotId: null, snapshotDigest: null } : row;
    ctx.fail(
      retained,
      operation,
      gitError('OPERATION_FAILED', '回收被中断，已保留工作目录。'),
      returned ? 'interrupted' : 'relocated',
    );
    return;
  }
  if ((await pathExists(worktreePath(ctx.managed, project, row))) || manifest.oid !== operation.oid)
    throw gitError('OPERATION_FAILED', '回收被中断，已保留工作目录。');
  ctx.store.transaction(() =>
    ctx.finish({ ...row, directoryIdentity: null, adminIdentity: null, retained: null }, operation),
  );
}

export async function recoverWorktrees(ctx: WorktreeLifecycleContext): Promise<void> {
  for (const operation of ctx.store.gitWorktrees.pendingOperations()) {
    const row = ctx.store.gitWorktrees.byId(operation.worktreeId);
    if (!row) continue;
    const project = ctx.store.get('projects', row.projectId);
    try {
      if (operation.kind === 'create') await ctx.completeCreate(project, row, operation);
      else if (operation.kind === 'reclaim')
        await recoverReclaimWorktree(ctx, project, row, operation);
      else {
        const git = await openWorktreeRepository(project, row);
        await discardScratchWorktree(
          git,
          scratchPath(ctx.managed, 'restore', operation.id),
          operation.scratchIdentity,
        );
        await completeRestoreWorktree(ctx, project, row, operation);
      }
    } catch (error) {
      const parked =
        operation.kind === 'reclaim' &&
        row.snapshotId === operation.id &&
        (await pathExists(scratchPath(ctx.managed, 'reclaim', operation.id)).catch(() => false));
      ctx.fail(row, operation, error, parked ? 'relocated' : 'interrupted');
    }
  }
}
