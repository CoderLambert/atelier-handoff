/**
 * @file 管理多提交计划的生成、编辑、预览和确认状态。
 * @implementation 分开读取快照、主动分析及本地审查。分析期间按快照和编号读取进度，恢复结果时保留用户编辑。
 * @updated 2026-11-24T22:06:05+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { useUiTranslation } from '@/i18n';
import { gatewayModelSchema, magpieModelPrefix } from '@shared/types';
import { useAppConfig } from '@/use-query/settings/use-app-config';
import { useGatewayModels } from '@/use-query/settings/use-gateway-models';
import { useDraftMultiCommit } from '@/use-query/git/use-draft-multi-commit';
import { useCommitAnalysisProgress } from '@/use-query/git/use-commit-analysis-progress';
import { useValidateMultiCommit } from '@/use-query/git/use-validate-multi-commit';
import { useSubmitMultiCommit } from '@/use-query/git/use-submit-multi-commit';
import {
  multiCommitValidate,
  type MultiCommitDraft,
  type MultiCommitDraftRequest,
  type MultiCommitGroup,
  type MultiCommitPreview,
  type MultiCommitValidate,
} from '@shared/git-multi-commit';

type EditedPlan = { groups: MultiCommitGroup[]; excludedUnitIds: string[] };
type CheckedPlan = { input: MultiCommitValidate; result: MultiCommitPreview };
type Attempt = Required<Pick<MultiCommitDraftRequest, 'analysisId' | 'locale' | 'model'>>;
type AnalysisAction = 'start' | 'retry' | 'continue' | 'finalize' | 'check';

const errorCode = (cause: unknown) => (cause instanceof ApiError ? cause.code : undefined);
const canCheckAttempt = (cause: unknown) =>
  !(cause instanceof ApiError) || cause.status >= 500 || cause.code === 'GIT_PLAN_ANALYSIS_BUSY';

export function useGitMultiCommitReview(
  projectId: string,
  treeId: string,
  onBusy: (busy: boolean) => void,
) {
  const { locale } = useUiTranslation('git');
  const preparation = useDraftMultiCommit(projectId, treeId);
  const validation = useValidateMultiCommit(projectId, treeId);
  const submission = useSubmitMultiCommit(projectId, treeId);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const executing = useRef(false);
  const operationId = useRef<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<MultiCommitDraft>();
  const [plan, setPlan] = useState<EditedPlan>({ groups: [], excludedUnitIds: [] });
  const [checked, setChecked] = useState<CheckedPlan>();
  const [error, setError] = useState<unknown>();
  const [receipt, setReceipt] = useState<string[]>();
  const [stale, setStale] = useState(false);
  const [validating, setValidating] = useState(false);
  const [preparing, setPreparing] = useState<'snapshot' | 'analysis' | false>(false);
  const [model, setModel] = useState<string>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [attempted, setAttempted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [groupLimitReached, setGroupLimitReached] = useState(false);
  const visible = useRef(false);
  const validatingRequest = useRef(false);
  const editedPlan = useRef(plan);
  const touchedUnits = useRef(new Set<string>());
  const userEdited = useRef(false);
  const config = useAppConfig();
  const catalog = useGatewayModels(open);
  const defaultModel = config.data?.config.model ?? catalog.data?.defaultModel;
  const effectiveModel = model ?? defaultModel;
  const modelValid = gatewayModelSchema.shape.id.safeParse(effectiveModel).success;
  const modelUnavailable =
    effectiveModel?.trim().startsWith(magpieModelPrefix) === true && !catalog.magpieEnabled;
  const currentAnalysis =
    attempt && draft?.analysis?.id === attempt.analysisId ? draft.analysis : undefined;
  const canResume = Boolean(
    attempt && (recovering || currentAnalysis?.canResume || currentAnalysis?.state === 'running'),
  );
  const analysisAction: AnalysisAction | null =
    !draft?.modelCandidateIds.length ||
    stale ||
    (draft.suggestionStatus === 'ready' && draft.groups.length > 0)
      ? null
      : canResume
        ? recovering || currentAnalysis?.state === 'running'
          ? 'check'
          : currentAnalysis?.globalPass === 'pending' &&
              currentAnalysis.completedBatchCount === currentAnalysis.batchCount
            ? 'finalize'
            : 'continue'
        : attempted
          ? 'retry'
          : 'start';
  const canAnalyze = Boolean(analysisAction && (canResume || (modelValid && !modelUnavailable)));
  const progress = useCommitAnalysisProgress(
    projectId,
    treeId,
    open && preparing === 'analysis' && analysisAction !== 'check' && attempt && draft
      ? { analysisId: attempt.analysisId, version: draft.version }
      : undefined,
  );
  const showEditor = Boolean(
    draft?.units.length &&
    (editing ||
      plan.groups.length ||
      plan.excludedUnitIds.length ||
      draft.suggestionStatus === 'ready' ||
      draft.analysis?.completedBatchCount),
  );

  useEffect(
    () => () => {
      generation.current++;
      request.current?.abort();
    },
    [],
  );

  async function prepare(
    kind: 'snapshot' | 'analysis',
    load: (signal: AbortSignal) => Promise<MultiCommitDraft>,
  ) {
    if (!visible.current || executing.current || validatingRequest.current || request.current)
      return;
    const controller = new AbortController();
    const current = ++generation.current;
    request.current = controller;
    setPreparing(kind);
    setError(undefined);
    try {
      const next = await load(controller.signal);
      if (controller.signal.aborted || current !== generation.current) return;
      if (kind === 'analysis') setAttempted(true);
      setRecovering(false);
      if (kind === 'snapshot' || !(next.analysis?.canResume || next.analysis?.state === 'running'))
        setAttempt(undefined);
      setDraft(next);
      const previous = editedPlan.current;
      if (kind === 'snapshot') {
        const ids = new Set(next.units.map((unit) => unit.id));
        editedPlan.current = {
          groups: previous.groups.map((group) => ({
            ...group,
            unitIds: group.unitIds.filter((id) => ids.has(id)),
          })),
          excludedUnitIds: previous.excludedUnitIds.filter((id) => ids.has(id)),
        };
        // The old coverage belongs to the previous snapshot. Preserve surviving edits.
        if (previous.groups.length || previous.excludedUnitIds.length) userEdited.current = true;
        setAttempted(false);
        setGroupLimitReached(false);
      } else if (userEdited.current) {
        const occupied = new Set([
          ...previous.groups.flatMap((group) => group.unitIds),
          ...previous.excludedUnitIds,
          ...touchedUnits.current,
        ]);
        const additions = next.groups
          .map((group) => ({ ...group, unitIds: group.unitIds.filter((id) => !occupied.has(id)) }))
          .filter((group) => group.unitIds.length > 0);
        const capacity = Math.max(0, 120 - previous.groups.length);
        setGroupLimitReached(
          Boolean(next.analysis?.groupLimitReached) || additions.length > capacity,
        );
        editedPlan.current = {
          groups: [...previous.groups, ...additions.slice(0, capacity)],
          excludedUnitIds: previous.excludedUnitIds,
        };
      } else {
        setGroupLimitReached(Boolean(next.analysis?.groupLimitReached));
        editedPlan.current = { groups: next.groups, excludedUnitIds: [] };
      }
      setPlan(editedPlan.current);
      setChecked(undefined);
      setStale(false);
      operationId.current = undefined;
    } catch (cause) {
      if (controller.signal.aborted || current !== generation.current) return;
      const code = errorCode(cause);
      if (code === 'GIT_PLAN_STALE') setStale(true);
      if (kind === 'analysis') {
        setAttempted(true);
        const unknown = canCheckAttempt(cause);
        setRecovering(unknown);
        if (!unknown) {
          setAttempt(undefined);
          // A replacement session may supply a plan, but still keep validated groups.
          if (editedPlan.current.groups.length) userEdited.current = true;
        }
      }
      setError(cause);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPreparing(false);
      }
    }
  }

  function refreshSnapshot() {
    return prepare('snapshot', (signal) =>
      preparation.mutateAsync({ locale, generate: false, signal }),
    );
  }

  function analyze() {
    if (!canAnalyze || !draft || request.current || validatingRequest.current || executing.current)
      return;
    const parsedModel = gatewayModelSchema.shape.id.safeParse(effectiveModel);
    const resume = canResume && attempt !== undefined;
    const active = resume
      ? attempt
      : parsedModel.success
        ? { analysisId: crypto.randomUUID(), model: parsedModel.data, locale }
        : undefined;
    if (!active) return;
    const generate = analysisAction !== 'check';
    setAttempt(active);
    return prepare('analysis', async (signal) => {
      const input = { ...active, version: draft.version, signal };
      try {
        return await preparation.mutateAsync({ ...input, generate, resume });
      } catch (cause) {
        if (!generate || signal.aborted || !canCheckAttempt(cause)) throw cause;
        return preparation.mutateAsync({ ...input, generate: false, resume: true });
      }
    });
  }

  function start() {
    if (visible.current || executing.current) return;
    visible.current = true;
    generation.current++;
    editedPlan.current = { groups: [], excludedUnitIds: [] };
    setAttempt(undefined);
    setAttempted(false);
    setEditing(false);
    touchedUnits.current = new Set();
    userEdited.current = false;
    setRecovering(false);
    setGroupLimitReached(false);
    setModel(undefined);
    setOpen(true);
    setDraft(undefined);
    setPlan({ groups: [], excludedUnitIds: [] });
    setChecked(undefined);
    setError(undefined);
    setReceipt(undefined);
    setStale(false);
    operationId.current = undefined;
    void refreshSnapshot();
  }

  function close() {
    if (executing.current) return;
    visible.current = false;
    generation.current++;
    request.current?.abort();
    request.current = null;
    validatingRequest.current = false;
    setPreparing(false);
    setValidating(false);
    setOpen(false);
  }

  function selectModel(next?: string) {
    if (executing.current || request.current || validatingRequest.current) return;
    if (currentAnalysis?.state === 'partial' && currentAnalysis.completedBatchCount === 0) {
      setAttempt(undefined);
      setRecovering(false);
    }
    setModel(next);
  }

  function update(groups: MultiCommitGroup[], excludedUnitIds: string[]) {
    if (executing.current || request.current || validatingRequest.current) return;
    userEdited.current = true;
    const assignments = (value: EditedPlan) => {
      const map = new Map<string, string>();
      for (const group of value.groups) for (const id of group.unitIds) map.set(id, group.id);
      for (const id of value.excludedUnitIds) map.set(id, 'excluded');
      return map;
    };
    const before = assignments(editedPlan.current);
    const after = assignments({ groups, excludedUnitIds });
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) !== after.get(id)) touchedUnits.current.add(id);
    }
    editedPlan.current = { groups, excludedUnitIds };
    setPlan(editedPlan.current);
    setChecked(undefined);
    setError(undefined);
    operationId.current = undefined;
    generation.current++;
  }

  async function preview() {
    if (
      !visible.current ||
      !draft ||
      stale ||
      request.current ||
      validatingRequest.current ||
      executing.current
    )
      return;
    const parsed = multiCommitValidate.safeParse({ version: draft.version, ...plan });
    if (!parsed.success) return;
    const current = ++generation.current;
    validatingRequest.current = true;
    setValidating(true);
    setError(undefined);
    try {
      const result = await validation.mutateAsync(parsed.data);
      if (current === generation.current) {
        editedPlan.current = {
          groups: parsed.data.groups,
          excludedUnitIds: parsed.data.excludedUnitIds,
        };
        setPlan(editedPlan.current);
        setChecked({ input: parsed.data, result });
      }
    } catch (cause) {
      if (current !== generation.current) return;
      setError(cause);
      if (cause instanceof ApiError && cause.code === 'GIT_PLAN_STALE') setStale(true);
    } finally {
      if (current === generation.current) {
        validatingRequest.current = false;
        setValidating(false);
      }
    }
  }

  async function confirm() {
    if (
      !visible.current ||
      !checked ||
      stale ||
      executing.current ||
      validatingRequest.current ||
      request.current
    )
      return;
    executing.current = true;
    onBusy(true);
    setError(undefined);
    operationId.current ??= crypto.randomUUID();
    try {
      const result = await submission.mutateAsync({
        ...checked.input,
        operationId: operationId.current,
        digest: checked.result.digest,
      });
      setReceipt(result.commits);
      visible.current = false;
      setOpen(false);
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError && cause.code === 'GIT_PLAN_STALE') setStale(true);
    } finally {
      executing.current = false;
      onBusy(false);
    }
  }

  return {
    open,
    draft,
    groups: plan.groups,
    excludedUnitIds: plan.excludedUnitIds,
    checked,
    error,
    stale,
    receipt,
    preparing,
    model,
    defaultModel,
    analyzedModel: draft?.analysisModel,
    catalog,
    modelUnavailable,
    canAnalyze,
    canResume,
    analysisAction,
    analysisProgress: progress.data?.progress,
    attempted,
    showEditor,
    groupLimitReached,
    openEditor: () => setEditing(true),
    selectModel,
    validating,
    committing: submission.isPending,
    start,
    close,
    analyze,
    refreshSnapshot,
    update,
    preview,
    confirm,
  };
}
