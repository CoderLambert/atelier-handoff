/**
 * @file 提供工作树多提交草稿、校验、确认和恢复接口。
 * @implementation 解析共享请求并转交多提交用例；只为分析和 AI 修改绑定断开信号。
 * @updated 2026-11-26T23:24:11+08:00
 */
import { z } from 'zod';
import {
  multiCommitDraftRequest,
  multiCommitRevisionRequest,
  multiCommitSubmit,
  multiCommitValidate,
} from '../../../shared/git-multi-commit.js';
import type { Project } from '../../../shared/types.js';
import {
  prepareCommitPlanDraft,
  type CommitPlanDraftDependencies,
} from '../../modules/git/commit-plan-draft.js';
import {
  executeWorktreeCommitPlan,
  previewWorktreeCommitPlan,
  resolveWorktreeCommitPlan,
  type CommitPlanStore,
} from '../../modules/git/commit-plan-operations.js';
import type { DevelopmentWorktrees } from '../../modules/git/development-worktrees.js';
import { body } from '../body.js';
import { json } from '../response.js';
import type { RouteRequest } from '../types.js';
import { withGitDisconnect } from './disconnect.js';

interface CommitPlanOptions extends CommitPlanDraftDependencies {
  store: CommitPlanStore;
  worktrees: Pick<DevelopmentWorktrees, 'checkout' | 'writeCheckout'>;
}

const commitPlanOperation = z.strictObject({ operationId: z.uuid() });

export async function postCommitPlan(
  options: CommitPlanOptions,
  { req, res, parts }: RouteRequest,
  project: Project,
  id: string,
) {
  const { store, worktrees } = options;
  const action = parts[6];
  switch (action) {
    case 'commit-plan':
    case 'commit-plan-revise': {
      const raw = await body(req);
      const plan = prepareCommitPlanDraft(
        options,
        project,
        id,
        action === 'commit-plan-revise'
          ? { kind: 'revision', input: multiCommitRevisionRequest.parse(raw) }
          : { kind: 'draft', input: multiCommitDraftRequest.parse(raw) },
      );
      return withGitDisconnect(res, async (signal) => json(res, await plan(signal)));
    }
    case 'commit-plan-validate': {
      const input = multiCommitValidate.parse(await body(req));
      return json(res, await previewWorktreeCommitPlan(worktrees, project, id, input));
    }
    case 'commit-plan-execute': {
      const input = multiCommitSubmit.parse(await body(req));
      return json(res, await executeWorktreeCommitPlan(store, worktrees, project, id, input), 201);
    }
    case 'commit-plan-recover':
    case 'commit-plan-abandon': {
      const { operationId } = commitPlanOperation.parse(await body(req));
      const result = await resolveWorktreeCommitPlan(
        store,
        worktrees,
        project,
        id,
        operationId,
        action === 'commit-plan-abandon' ? 'abandon' : 'recover',
      );
      return json(res, result);
    }
    default:
      return false;
  }
}
