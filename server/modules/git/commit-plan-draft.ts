/**
 * @file 从已授权工作树读取、分析或修改多提交草稿。
 * @implementation 在读取快照前检查补充要求，按当前模型配置调度分析或修改，仅返回可公开的变更单元和进度。
 * @updated 2026-11-26T23:24:11+08:00
 */
import type {
  MultiCommitDraft,
  MultiCommitDraftRequest,
  MultiCommitRevisionRequest,
} from '../../../shared/git-multi-commit.js';
import { AppError, type AppConfig, type Project } from '../../../shared/types.js';
import { gatewayModelId } from '../../gateway-models.js';
import { magpieModel } from '../../magpie-models.js';
import type { GatewayService } from '../gateway/service.js';
import {
  commitAnalysisCandidates,
  type CommitAnalysisSessions,
} from './commit-analysis-sessions.js';
import { canSendCommitDiff } from './commit-plan-privacy.js';
import { reviseCommitPlan } from './commit-plan-revision.js';
import { readCommitPlanSnapshot } from './commit-plan-snapshot.js';
import { commitPlanUnits } from './commit-plan-view.js';
import type { DevelopmentWorktrees } from './development-worktrees.js';
import { gitError } from './git-cli.js';

export interface CommitPlanDraftDependencies {
  worktrees: Pick<DevelopmentWorktrees, 'checkout'>;
  commitAnalyses: Pick<CommitAnalysisSessions, 'analyze'>;
  gateway: Pick<GatewayService, 'effectiveConfig' | 'magpie' | 'requireMagpieEnabled'>;
}

type DraftRequest =
  | { kind: 'draft'; input: MultiCommitDraftRequest }
  | { kind: 'revision'; input: MultiCommitRevisionRequest };

export function prepareCommitPlanDraft(
  { worktrees, commitAnalyses, gateway }: CommitPlanDraftDependencies,
  project: Project,
  id: string,
  request: DraftRequest,
) {
  const input: MultiCommitDraftRequest =
    request.kind === 'revision' ? { ...request.input, generate: true } : request.input;
  // Reject private instructions before entering cancellable checkout or model work.
  if (input.instruction && !canSendCommitDiff(input.instruction))
    throw gitError('PLAN_INSTRUCTION_PRIVATE', '补充要求可能包含凭据，请删除后重试。');

  return async (signal: AbortSignal) => {
    const { git } = await worktrees.checkout(project, id, signal);
    const snapshot = await readCommitPlanSnapshot(git, signal);
    if (input.version !== undefined && input.version !== snapshot.version)
      throw gitError('PLAN_STALE', '工作树已变化，请重新读取提交快照。');
    const units = commitPlanUnits(snapshot);
    if (units.length > 4096)
      throw gitError('PLAN_LIMIT', '变更单元过多，请缩小本次工作区范围后重试。', 413);
    const candidates = commitAnalysisCandidates(units);
    const defaults = gateway.effectiveConfig();
    const model = input.model ?? defaults.model;
    const nativeMagpieModel = magpieModel(model);
    const { magpie } = gateway;
    let config: AppConfig | undefined = { ...defaults, model, effort: input.effort };
    if (nativeMagpieModel !== undefined) {
      const validModel = gatewayModelId.safeParse(nativeMagpieModel).success;
      if (input.generate && input.model !== undefined) {
        gateway.requireMagpieEnabled();
        if (!magpie || !validModel)
          throw new AppError('MAGPIE_UNAVAILABLE', 'Magpie 网关未配置或模型 ID 无效。', 400);
      }
      config =
        defaults.magpieEnabled && magpie && validModel
          ? { ...config, gateway: magpie, managedGateway: false }
          : undefined;
    }
    if (input.resume && !config)
      throw gitError('PLAN_ANALYSIS_STALE', '模型接入配置已变化，请重新开始。');
    if (request.kind === 'revision') {
      if (!config) throw gitError('PLAN_REVISION_FAILED', 'AI 修改请求未完成。', 502);
      return reviseCommitPlan(config, request.input, units, candidates, signal);
    }
    const analyzed =
      config && ((input.generate && candidates.length > 0) || input.resume)
        ? await commitAnalyses.analyze({
            scope: {
              projectId: project.id,
              worktreeId: id,
              version: snapshot.version,
              repositoryId: snapshot.repositoryId,
              rootIdentity: snapshot.rootIdentity,
              adminIdentity: snapshot.adminIdentity,
            },
            config,
            locale: input.locale,
            candidates,
            instruction: input.instruction,
            analysisId: input.analysisId,
            resume: input.resume,
            generate: input.generate,
            signal,
          })
        : undefined;
    const suggestion = analyzed?.result;
    const ready = analyzed?.analysis.state === 'complete';
    const groups = analyzed?.groups ?? [];
    const assigned = new Set(groups.flatMap((group) => group.unitIds));
    const draft: MultiCommitDraft = {
      version: snapshot.version,
      branch: snapshot.target.ref.startsWith('refs/heads/')
        ? snapshot.target.ref.slice('refs/heads/'.length)
        : null,
      units: units.map(({ diff: _diff, ...unit }) => unit),
      groups,
      modelCandidateIds: candidates.map((candidate) => candidate.id),
      unassignedUnitIds: units.filter((unit) => !assigned.has(unit.id)).map((unit) => unit.id),
      suggestionStatus: ready ? 'ready' : analyzed ? 'partial' : 'manual',
      ...(analyzed ? { analysis: analyzed.analysis } : {}),
      ...(suggestion && suggestion.coverage.batchCount > 0 ? { analysisModel: model } : {}),
      suggestionReason: analyzed
        ? analyzed.analysis.reason
        : input.generate
          ? 'unavailable'
          : 'manual',
      coverage: {
        analyzed: ready ? candidates.length : (suggestion?.coverage.completedUnitIds.length ?? 0),
        metadataOnly: candidates.filter((candidate) => !candidate.diff).length,
        excluded: units.length - candidates.length,
      },
    };
    return draft;
  };
}
