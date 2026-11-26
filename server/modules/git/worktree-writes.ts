/**
 * @file 管理工作树文件变更和单提交用例。
 * @implementation 在已授权检出上读取暂存草稿和可选模型建议；工作区修改、暂存和提交使用同一排他写入边界。
 * @updated 2026-11-26T23:24:11+08:00
 */
import type { z } from 'zod';
import type {
  gitCommitDraftRequest,
  GitCommitRequest,
  GitFileDiscardRequest,
  GitFileIndexRequest,
} from '../../../shared/git-workbench.js';
import type { Project } from '../../../shared/types.js';
import { magpieModel } from '../../magpie-models.js';
import type { GatewayService } from '../gateway/service.js';
import { suggestCommitMessage } from './commit-suggestion.js';
import type { DevelopmentWorktrees } from './development-worktrees.js';
import { discardGitFiles } from './git-file-discard.js';
import { updateGitFileIndex } from './git-file-index.js';
import { commitStagedChanges, readStagedChanges } from './staged-commit.js';

export async function draftWorktreeCommit(
  worktrees: Pick<DevelopmentWorktrees, 'checkout'>,
  gateway: Pick<GatewayService, 'effectiveConfig' | 'magpie'>,
  project: Project,
  id: string,
  input: z.output<typeof gitCommitDraftRequest>,
  signal: AbortSignal,
) {
  const { git } = await worktrees.checkout(project, id, signal);
  const { draft, patch } = await readStagedChanges(git, input.generate, signal);
  const defaults = gateway.effectiveConfig();
  const { magpie } = gateway;
  const config =
    magpieModel(defaults.model) === undefined
      ? defaults
      : defaults.magpieEnabled && magpie
        ? { ...defaults, gateway: magpie, managedGateway: false }
        : undefined;
  if (config && input.generate)
    draft.suggestion = await suggestCommitMessage(config, input.locale, draft, patch, signal);
  return draft;
}

export function discardWorktreeFiles(
  worktrees: Pick<DevelopmentWorktrees, 'writeCheckout'>,
  project: Project,
  id: string,
  input: GitFileDiscardRequest,
) {
  return worktrees.writeCheckout(project, id, (git) => discardGitFiles(git, input));
}

export function updateWorktreeIndex(
  worktrees: Pick<DevelopmentWorktrees, 'writeCheckout'>,
  project: Project,
  id: string,
  input: GitFileIndexRequest,
) {
  return worktrees.writeCheckout(project, id, (git) => updateGitFileIndex(git, input));
}

export function commitWorktreeIndex(
  worktrees: Pick<DevelopmentWorktrees, 'writeCheckout'>,
  project: Project,
  id: string,
  input: GitCommitRequest,
) {
  return worktrees.writeCheckout(project, id, (git) => commitStagedChanges(git, input));
}
