/**
 * @file 保存短期 AI 多提交分析批次并提供实时进度。
 * @implementation 将快照、模型、补充要求和披露策略绑定到分析会话，保存经验证的批次，并按项目、工作树与快照返回进度。
 * @updated 2026-11-27T21:40:00+08:00
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { gatewayToken } from '../../gateway-search.js';
import {
  MAX_MULTI_COMMIT_GROUPS,
  type MultiCommitAnalysis,
  type MultiCommitGroup,
  type MultiCommitProgress,
  type MultiCommitUnit,
} from '../../../shared/git-multi-commit.js';
import type { UiLocale } from '../../../shared/i18n/locale.js';
import { AppError, type AppConfig } from '../../../shared/types.js';
import {
  commitPlanLimits,
  suggestCommitPlan,
  type CommitPlanCheckpoint,
  type CommitPlanResult,
  type CommitPlanUnit,
} from './commit-planner.js';

export const commitAnalysisLimits = Object.freeze({
  maxSessions: 8,
  ttlMs: 15 * 60_000,
  // At most 16 bounded batch responses and one final response, plus small ID metadata.
  maxSessionBytes: 8 * 1024 * 1024,
  maxVisibleGroups: MAX_MULTI_COMMIT_GROUPS,
});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Match compiler restrictions before any metadata or diff is disclosed to the model. */
export function commitAnalysisCandidates(units: readonly MultiCommitUnit[]): CommitPlanUnit[] {
  const eligible = new Set(
    units
      .filter((unit) => unit.kind !== 'unsupported' && unit.reason !== 'rename' && !unit.credential)
      .map((unit) => unit.id),
  );
  let removed = true;
  while (removed) {
    removed = false;
    for (const unit of units) {
      if (eligible.has(unit.id) && unit.dependsOn.some((id) => !eligible.has(id))) {
        eligible.delete(unit.id);
        removed = true;
      }
    }
  }
  return units
    .filter((unit) => eligible.has(unit.id))
    .map(({ id, path, layer, description, diff }) => ({
      id,
      path,
      layer,
      description,
      ...(diff && diff.length <= commitPlanLimits.maxDiffChars ? { diff } : {}),
    }));
}

export interface CommitAnalysisScope {
  projectId: string;
  worktreeId: string;
  version: string;
  repositoryId: string;
  rootIdentity: string;
  adminIdentity: string;
}
type ProgressScope = Pick<CommitAnalysisScope, 'projectId' | 'worktreeId' | 'version'>;
interface AnalyzeInput {
  scope: CommitAnalysisScope;
  config: AppConfig;
  locale: UiLocale;
  candidates: readonly CommitPlanUnit[];
  instruction?: string;
  analysisId?: string;
  resume?: boolean;
  generate: boolean;
  signal: AbortSignal;
}
interface AnalysisSession {
  id: string;
  binding: string;
  progressScope: ProgressScope;
  expiresAt: number;
  checkpoint: CommitPlanCheckpoint;
  result: CommitPlanResult;
  running?: AbortController;
}
export interface CommitAnalysisOutput {
  result: CommitPlanResult;
  groups: MultiCommitGroup[];
  analysis: MultiCommitAnalysis;
}

function groupId(analysisId: string, group: CommitPlanResult['groups'][number]): string {
  const value = hash(analysisId + ':' + JSON.stringify(group));
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
const failure = (code: string, message: string, status = 409) =>
  new AppError('GIT_PLAN_ANALYSIS_' + code, message, status);

/** One instance belongs to one application runtime; restart intentionally expires all sessions. */
export class CommitAnalysisSessions {
  private readonly sessions = new Map<string, AnalysisSession>();
  private readonly bindingKey = randomBytes(32);
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly planner: typeof suggestCommitPlan;

  constructor(
    options: {
      now?: () => number;
      ttlMs?: number;
      maxSessions?: number;
      planner?: typeof suggestCommitPlan;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? commitAnalysisLimits.ttlMs;
    this.maxSessions = options.maxSessions ?? commitAnalysisLimits.maxSessions;
    this.planner = options.planner ?? suggestCommitPlan;
    this.timer = setInterval(() => this.expire(), 60_000);
    this.timer.unref();
  }

  private expire() {
    for (const [id, session] of this.sessions) {
      if (!session.running && session.expiresAt <= this.now()) this.sessions.delete(id);
    }
  }

  private output(session: AnalysisSession): CommitAnalysisOutput {
    const result = structuredClone(session.result);
    const groupLimitReached = result.groups.length > commitAnalysisLimits.maxVisibleGroups;
    const groups = result.groups.slice(0, commitAnalysisLimits.maxVisibleGroups).map((group) => ({
      ...group,
      id: groupId(session.id, group),
    }));
    return {
      result,
      groups,
      analysis: {
        id: session.id,
        state: session.running
          ? 'running'
          : result.status === 'ready' && !groupLimitReached
            ? 'complete'
            : 'partial',
        reason: session.running
          ? null
          : result.status === 'manual'
            ? result.reason
            : groupLimitReached
              ? 'group-limit'
              : null,
        batchCount: result.coverage.batchCount,
        completedBatchCount: result.coverage.completedBatchCount,
        completedUnitIds: result.coverage.completedUnitIds,
        globalPass: result.coverage.globalPass,
        canResume: !session.running && (result.status !== 'ready' || groupLimitReached),
        groupLimitReached,
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
    };
  }

  /** Only counts from an active frozen analysis. This read does not extend the session lifetime. */
  progress(scope: ProgressScope, id: string): MultiCommitProgress | null {
    const session = this.sessions.get(id);
    if (
      !session?.running ||
      session.progressScope.projectId !== scope.projectId ||
      session.progressScope.worktreeId !== scope.worktreeId ||
      session.progressScope.version !== scope.version
    )
      return null;
    const { batchCount, completedBatchCount, completedUnitIds, globalPass } =
      session.result.coverage;
    return {
      stage: !batchCount
        ? 'preparing'
        : completedBatchCount < batchCount
          ? 'batch'
          : globalPass === 'pending'
            ? 'organizing'
            : 'finishing',
      batchCount,
      completedBatchCount,
      analyzed: completedUnitIds.length,
      suggestedGroups: session.result.groups.length,
    };
  }

  async analyze(input: AnalyzeInput): Promise<CommitAnalysisOutput> {
    if (this.closed) throw failure('CLOSED', '分析服务正在关闭。', 503);
    this.expire();
    const id = input.analysisId ?? randomUUID();
    // Hash raw input immediately; sessions contain no credentials, paths or diff payloads.
    const binding = hash(
      JSON.stringify({
        ...input.scope,
        model: input.config.model,
        effort: input.config.effort ?? null,
        gateway: input.config.gateway,
        credential: createHmac('sha256', this.bindingKey)
          .update(gatewayToken(input.config))
          .digest('hex'),
        locale: input.locale,
        instruction: input.instruction,
        disclosurePolicy: 'commit-analysis-v2',
        candidates: input.candidates,
      }),
    );
    let session = this.sessions.get(id);
    if (input.resume && !session) throw failure('EXPIRED', '分析记录已过期，请重新开始。', 410);
    if (session && session.binding !== binding)
      throw failure('STALE', '工作树、模型或分析范围已变化，请重新开始。');
    if (session?.running && input.generate)
      throw failure('BUSY', '本次分析仍在进行，请等待或取消。');
    if (!session) {
      if (!input.generate) throw failure('EXPIRED', '分析记录不存在，请重新开始。', 410);
      if (this.sessions.size >= this.maxSessions) {
        const idle = [...this.sessions.values()]
          .filter(
            (item) =>
              !item.running &&
              item.result.status === 'ready' &&
              item.result.groups.length <= commitAnalysisLimits.maxVisibleGroups,
          )
          .sort((a, b) => a.expiresAt - b.expiresAt)[0];
        if (!idle) throw failure('BUSY', '分析记录已满，请稍后重试。', 429);
        this.sessions.delete(idle.id);
      }
      session = {
        id,
        binding,
        progressScope: {
          projectId: input.scope.projectId,
          worktreeId: input.scope.worktreeId,
          version: input.scope.version,
        },
        expiresAt: this.now() + this.ttlMs,
        checkpoint: { batches: [] },
        result: {
          status: 'manual',
          reason: 'cancelled',
          groups: [],
          unassignedUnitIds: input.candidates.map((unit) => unit.id),
          coverage: {
            batchCount: 0,
            completedBatchCount: 0,
            completedUnitIds: [],
            globalPass: 'not-needed',
            diffUnitIds: [],
            metadataOnlyUnitIds: [],
          },
        },
      };
      this.sessions.set(id, session);
    }
    // A repeated start ID is idempotent too: never rerun a completed batch or final result.
    if (
      !input.generate ||
      (session.result.status === 'ready' &&
        session.result.groups.length <= commitAnalysisLimits.maxVisibleGroups)
    )
      return this.output(session);
    const active = session;
    const controller = new AbortController();
    active.running = controller;
    try {
      active.result = await this.planner(
        input.config,
        input.locale,
        input.candidates,
        AbortSignal.any([input.signal, controller.signal]),
        {
          timeoutMs: 120_000,
          instruction: input.instruction,
          checkpoint: active.checkpoint,
          onStart: (coverage) => {
            active.result = { ...active.result, coverage };
          },
          onProgress: (checkpoint, result) => {
            const bytes = Buffer.byteLength(JSON.stringify({ checkpoint, result }), 'utf8');
            // The planner's response budgets bound this below the reservation for valid inputs.
            if (bytes > commitAnalysisLimits.maxSessionBytes)
              throw failure('LIMIT', '分析摘要过大，请缩小分析范围。', 413);
            active.checkpoint = checkpoint;
            active.result = checkpoint.finalPlan
              ? result
              : { ...result, status: 'manual', reason: 'cancelled' };
            active.expiresAt = this.now() + this.ttlMs;
          },
        },
      );
      if (
        active.result.groups.length > commitAnalysisLimits.maxVisibleGroups &&
        active.result.status === 'ready'
      ) {
        // A final over-limit plan can be retried without repeating any initial batch.
        delete active.checkpoint.finalPlan;
        active.result = { ...active.result, status: 'manual', reason: 'group-limit' };
      }
    } finally {
      delete active.running;
      active.expiresAt = this.now() + this.ttlMs;
    }
    return this.output(active);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const session of this.sessions.values()) session.running?.abort();
    this.sessions.clear();
  }
}
