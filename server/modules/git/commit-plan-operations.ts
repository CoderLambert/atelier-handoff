/**
 * @file 预览、确认和恢复工作树上的多提交操作。
 * @implementation 将工作树锁、冻结快照、SQLite 回执和文件日志绑定到同一检出身份；查询待处理操作时不修复证据。
 * @updated 2026-11-26T23:24:11+08:00
 */
import { realpath } from 'node:fs/promises';
import {
  multiCommitValidate,
  type MultiCommitSubmit,
  type MultiCommitValidate,
} from '../../../shared/git-multi-commit.js';
import type { Project } from '../../../shared/types.js';
import { fingerprint } from '../../files.js';
import type { Store } from '../../store.js';
import { CommitJournal } from './commit-journal.js';
import {
  hashCommitRepositoryIdentity,
  type CommitOperationScope,
} from './commit-operation-repository.js';
import { commitPlanCoordinator } from './commit-plan-coordinator.js';
import { executeCommitPlan } from './commit-plan-execution.js';
import { validateCommitPlan } from './commit-plan-preview.js';
import { abandonCommitPlan, recoverCommitPlan } from './commit-plan-recovery.js';
import { readCommitPlanSnapshot } from './commit-plan-snapshot.js';
import type { DevelopmentWorktrees } from './development-worktrees.js';
import { fileIdentity, gitError, type LocalGit } from './git-cli.js';

export type CommitPlanStore = Pick<Store, 'directory' | 'gitCommitOperations'>;

function operationScope(
  projectId: string,
  git: LocalGit,
  rootIdentity: string,
  adminIdentity: string,
): CommitOperationScope {
  return {
    projectId,
    repositoryId: hashCommitRepositoryIdentity(git.repositoryId),
    worktreeIdentity: rootIdentity,
    adminIdentity,
  };
}

export async function previewWorktreeCommitPlan(
  worktrees: Pick<DevelopmentWorktrees, 'checkout'>,
  project: Project,
  id: string,
  input: MultiCommitValidate,
) {
  const { git } = await worktrees.checkout(project, id);
  const snapshot = await readCommitPlanSnapshot(git);
  return validateCommitPlan(snapshot, input).preview;
}

export async function executeWorktreeCommitPlan(
  store: CommitPlanStore,
  worktrees: Pick<DevelopmentWorktrees, 'writeCheckout'>,
  project: Project,
  id: string,
  input: MultiCommitSubmit,
) {
  const plan = multiCommitValidate.parse({
    version: input.version,
    groups: input.groups,
    excludedUnitIds: input.excludedUnitIds,
  });
  if (fingerprint(JSON.stringify(plan)) !== input.digest)
    throw gitError('PLAN_STALE', '提交计划已变化，请重新核对。');
  return worktrees.writeCheckout(project, id, async (git) => {
    const rootIdentity = await fileIdentity(git.root);
    const adminIdentity = await fileIdentity(git.admin);
    const journal = new CommitJournal(await realpath(store.directory));
    const coordinator = commitPlanCoordinator(
      store,
      journal,
      project.id,
      git.repositoryId,
      rootIdentity,
      adminIdentity,
      input.digest,
    );
    const scope = operationScope(project.id, git, rootIdentity, adminIdentity);
    const prior = store.gitCommitOperations.get(scope, input.operationId);
    if (prior) {
      const evidence = await coordinator.read(input.operationId);
      if (!evidence || evidence.state !== 'completed')
        throw gitError('PLAN_RECOVERY_REQUIRED', '提交尚需恢复核对，不能重复执行。');
      return { operationId: input.operationId, commits: evidence.commits };
    }
    // Reject an orphaned durable log before taking another snapshot or writing objects.
    if (await coordinator.read(input.operationId))
      throw gitError('PLAN_RECOVERY_REQUIRED', '提交尚需恢复核对，不能重复执行。');
    const snapshot = await readCommitPlanSnapshot(git);
    const { compiled, preview } = validateCommitPlan(snapshot, plan);
    if (preview.digest !== input.digest)
      throw gitError('PLAN_STALE', '提交计划已变化，请重新核对。');
    const executed = await executeCommitPlan(git, snapshot, compiled, {
      operationId: input.operationId,
      coordinator,
    });
    if (executed.state !== 'completed')
      throw gitError('PLAN_RECOVERY_REQUIRED', '提交尚需恢复核对，不能重复执行。');
    return { operationId: input.operationId, commits: executed.commits };
  });
}

export function resolveWorktreeCommitPlan(
  store: CommitPlanStore,
  worktrees: Pick<DevelopmentWorktrees, 'writeCheckout'>,
  project: Project,
  id: string,
  operationId: string,
  action: 'recover' | 'abandon',
) {
  return worktrees.writeCheckout(project, id, async (git) => {
    const rootIdentity = await fileIdentity(git.root);
    const adminIdentity = await fileIdentity(git.admin);
    const scope = operationScope(project.id, git, rootIdentity, adminIdentity);
    const record = store.gitCommitOperations.get(scope, operationId);
    const journal = new CommitJournal(await realpath(store.directory));
    const evidence = record ? undefined : await journal.read(operationId);
    const digest =
      record?.requestHash ??
      (evidence?.owner?.projectId === project.id ? evidence.owner.requestDigest : undefined);
    if (!digest)
      throw gitError('PLAN_RECOVERY_REQUIRED', '无法确认操作归属，请保留现场并人工核对。');
    const coordinator = commitPlanCoordinator(
      store,
      journal,
      project.id,
      git.repositoryId,
      rootIdentity,
      adminIdentity,
      digest,
    );
    // A prepared file log may have been durable before the SQLite claim was written.
    // Recreate only its project-bound metadata; recovery still verifies real Git state.
    if (!record) await coordinator.adoptOrphan(operationId);
    if (action === 'abandon') {
      const abandoned = await abandonCommitPlan(git, { operationId, journal, coordinator });
      if (abandoned.state !== 'aborted')
        throw gitError('PLAN_RECOVERY_REQUIRED', '无法确认操作尚未执行，未修改索引或引用。');
      return { operationId, aborted: true as const };
    }
    const recovered = await recoverCommitPlan(git, { operationId, journal, coordinator });
    if (recovered.state !== 'completed')
      throw gitError('PLAN_RECOVERY_REQUIRED', '提交需要人工核对，未覆盖索引或引用。');
    return { operationId, commits: recovered.commits };
  });
}

export async function listPendingCommitPlans(
  store: CommitPlanStore,
  projectId: string,
  git: LocalGit,
) {
  const rootIdentity = await fileIdentity(git.root);
  const adminIdentity = await fileIdentity(git.admin);
  const scope = operationScope(projectId, git, rootIdentity, adminIdentity);
  const records = store.gitCommitOperations.listUnfinished(scope, { limit: 200 });
  const journal = new CommitJournal(await realpath(store.directory));
  const evidence = (await journal.pending()).filter(
    (entry) =>
      entry.repositoryId === git.repositoryId &&
      entry.worktreeIdentity === rootIdentity &&
      entry.adminIdentity === adminIdentity &&
      (!entry.owner || entry.owner.projectId === projectId),
  );
  const ids = new Set([
    ...records.map((record) => record.operationId),
    ...evidence.map((entry) => entry.operationId),
  ]);
  return Promise.all(
    [...ids].map(async (operationId) => {
      const record = records.find((item) => item.operationId === operationId);
      const entry = await journal.read(operationId);
      let state = 'recovery_required';
      if (!record && entry?.state === 'prepared' && entry.owner?.projectId === projectId) {
        state = 'prepared';
      }
      if (record && entry) {
        try {
          const coordinator = commitPlanCoordinator(
            store,
            journal,
            projectId,
            git.repositoryId,
            rootIdentity,
            adminIdentity,
            record.requestHash,
          );
          await coordinator.readAllowAhead(operationId);
          state = record.state;
        } catch {
          // Keep unmatched evidence visible for manual review; never synchronize here.
        }
      }
      return { operationId, state, commits: record?.commits ?? entry?.commits ?? [] };
    }),
  );
}
