/**
 * @file 管理手动及 AI 多提交计划的分析、对话修改、预览和确认状态。
 * @implementation 恢复已验证的分析进度并保留编辑，支持撤销对话修改，并用同一验证摘要和操作 ID 重取执行回执。
 * @updated 2026-11-25T01:22:11+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { useUiTranslation } from '@/i18n';
import { gatewayModelSchema, magpieModelPrefix, type ReasoningEffort } from '@shared/types';
import { useGitMultiCommitPreferences } from '@/use-query/settings/use-git-multi-commit-preferences';
import { useUpdateGitMultiCommitPreferences } from '@/use-query/settings/use-update-git-multi-commit-preferences';
import { useAppConfig } from '@/use-query/settings/use-app-config';
import { useGatewayModels } from '@/use-query/settings/use-gateway-models';
import { useDraftMultiCommit } from '@/use-query/git/use-draft-multi-commit';
import { useReviseMultiCommit } from '@/use-query/git/use-revise-multi-commit';
import { useCommitAnalysisProgress } from '@/use-query/git/use-commit-analysis-progress';
import { useValidateMultiCommit } from '@/use-query/git/use-validate-multi-commit';
import { useSubmitMultiCommit } from '@/use-query/git/use-submit-multi-commit';
import {
  multiCommitValidate,
  multiCommitRevisionRequest,
  multiCommitInstruction,
  type MultiCommitDraft,
  type MultiCommitDraftRequest,
  type MultiCommitGroup,
  type MultiCommitPreview,
  type MultiCommitValidate,
} from '@shared/git-multi-commit';

type EditedPlan = { groups: MultiCommitGroup[]; excludedUnitIds: string[] };
type CheckedPlan = { input: MultiCommitValidate; result: MultiCommitPreview };
type Attempt = Required<Pick<MultiCommitDraftRequest, 'analysisId' | 'locale' | 'model'>> &
  Pick<MultiCommitDraftRequest, 'effort' | 'instruction'>;
type AnalysisAction = 'start' | 'retry' | 'continue' | 'finalize' | 'check';
type RevisionTurn = {
  id: string;
  instruction: string;
  note: string;
  before: EditedPlan;
  after: EditedPlan;
  touched: Set<string>;
  wasEdited: boolean;
};

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
  const revision = useReviseMultiCommit(projectId, treeId);
  const validation = useValidateMultiCommit(projectId, treeId);
  const submission = useSubmitMultiCommit(projectId, treeId);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const executing = useRef(false);
  const operationId = useRef<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState<MultiCommitDraft>();
  const [plan, setPlan] = useState<EditedPlan>({ groups: [], excludedUnitIds: [] });
  const [checked, setChecked] = useState<CheckedPlan>();
  const [error, setError] = useState<unknown>();
  const [receipt, setReceipt] = useState<string[]>();
  const [stale, setStale] = useState(false);
  const [validating, setValidating] = useState(false);
  const [preparing, setPreparing] = useState<'snapshot' | 'analysis' | 'revision' | false>(false);
  const [confirming, setConfirming] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [turns, setTurns] = useState<RevisionTurn[]>([]);
  const [details, setDetails] = useState(false);
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
  const preferences = useGitMultiCommitPreferences();
  const savePreferences = useUpdateGitMultiCommitPreferences();
  const catalog = useGatewayModels(open && !manual);
  const model = preferences.data?.model ?? undefined;
  const effort = preferences.data?.effort ?? undefined;
  const defaultModel = config.data?.config.model ?? catalog.data?.defaultModel;
  const effectiveModel = model ?? defaultModel;
  const currentRoute = catalog.data?.models.find((entry) => entry.id === effectiveModel);
  const fixedEffort = currentRoute?.effort;
  const unsupportedEffort =
    fixedEffort === undefined &&
    effort !== undefined &&
    currentRoute?.supportedEfforts !== undefined &&
    !currentRoute.supportedEfforts.includes(effort);
  const requestedEffort = fixedEffort === undefined ? effort : undefined;
  const modelValid = gatewayModelSchema.shape.id.safeParse(effectiveModel).success;
  const modelUnavailable =
    effectiveModel?.trim().startsWith(magpieModelPrefix) === true && !catalog.magpieEnabled;
  const currentAnalysis =
    attempt && draft?.analysis?.id === attempt.analysisId ? draft.analysis : undefined;
  const canResume = Boolean(
    attempt && (recovering || currentAnalysis?.canResume || currentAnalysis?.state === 'running'),
  );
  const analysisAction: AnalysisAction | null =
    manual ||
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
  const canAnalyze = Boolean(
    preferences.data &&
    !savePreferences.isPending &&
    analysisAction &&
    (canResume ||
      (modelValid &&
        !modelUnavailable &&
        !unsupportedEffort &&
        !(catalog.isFetching && !catalog.data))),
  );
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
  const canRevise =
    !manual &&
    showEditor &&
    !stale &&
    draft?.suggestionReason !== 'manual' &&
    Boolean(draft?.modelCandidateIds.length) &&
    gatewayModelSchema.shape.id.safeParse(draft?.analysisModel ?? effectiveModel).success;
  const lastEdit = turns.findLast((turn) => turn.before !== turn.after);
  const canUndo = Boolean(!stale && lastEdit && lastEdit.after === plan);
  const summaryInput =
    draft && !stale && !draft.units.some((unit) => unit.layer === 'conflict')
      ? multiCommitValidate.safeParse({ version: draft.version, ...plan })
      : undefined;
  const selected = new Set([
    ...plan.groups.flatMap((group) => group.unitIds),
    ...plan.excludedUnitIds,
  ]);
  const canConfirmSummary = Boolean(
    summaryInput?.success &&
    draft &&
    selected.size === draft.units.length &&
    draft.units.every((unit) => selected.has(unit.id)),
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
        if (draft?.version !== next.version) setTurns([]);
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
    const requirement = multiCommitInstruction.safeParse(instruction);
    const active = resume
      ? attempt
      : parsedModel.success
        ? {
            analysisId: crypto.randomUUID(),
            model: parsedModel.data,
            locale,
            ...(requestedEffort ? { effort: requestedEffort } : {}),
            ...(requirement.success ? { instruction: requirement.data } : {}),
          }
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

  function start(mode: 'ai' | 'manual') {
    if (visible.current || executing.current) return;
    visible.current = true;
    generation.current++;
    editedPlan.current = {
      groups:
        mode === 'manual' ? [{ id: crypto.randomUUID(), title: '', body: '', unitIds: [] }] : [],
      excludedUnitIds: [],
    };
    setManual(mode === 'manual');
    setAttempt(undefined);
    setTurns([]);
    setInstruction('');
    setDetails(false);
    setAttempted(false);
    setEditing(false);
    touchedUnits.current = new Set();
    userEdited.current = false;
    setRecovering(false);
    setGroupLimitReached(false);
    setOpen(true);
    setDraft(undefined);
    setPlan(editedPlan.current);
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
    if (
      !preferences.data ||
      (next !== undefined && !gatewayModelSchema.shape.id.safeParse(next).success)
    )
      return;
    savePreferences.mutate({ model: next ?? null, effort: null });
  }

  function selectEffort(next?: ReasoningEffort) {
    if (
      executing.current ||
      request.current ||
      validatingRequest.current ||
      !preferences.data ||
      fixedEffort !== undefined
    )
      return;
    if (next && currentRoute?.supportedEfforts && !currentRoute.supportedEfforts.includes(next))
      return;
    if (currentAnalysis?.state === 'partial' && currentAnalysis.completedBatchCount === 0) {
      setAttempt(undefined);
      setRecovering(false);
    }
    savePreferences.mutate({ ...preferences.data, effort: next ?? null });
  }

  function update(groups: MultiCommitGroup[], excludedUnitIds: string[]) {
    if (executing.current || request.current || validatingRequest.current) return;
    applyEdit({ groups, excludedUnitIds });
    generation.current++;
  }

  function applyEdit(next: EditedPlan) {
    userEdited.current = true;
    const assignments = (value: EditedPlan) => {
      const map = new Map<string, string>();
      for (const group of value.groups) for (const id of group.unitIds) map.set(id, group.id);
      for (const id of value.excludedUnitIds) map.set(id, 'excluded');
      return map;
    };
    const before = assignments(editedPlan.current);
    const after = assignments(next);
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) !== after.get(id)) touchedUnits.current.add(id);
    }
    editedPlan.current = next;
    setPlan(editedPlan.current);
    setChecked(undefined);
    setError(undefined);
    operationId.current = undefined;
  }

  async function revise(text: string): Promise<boolean> {
    if (
      !canRevise ||
      !draft ||
      !visible.current ||
      request.current ||
      validatingRequest.current ||
      executing.current
    )
      return false;
    const before = editedPlan.current;
    const input = multiCommitRevisionRequest.safeParse({
      ...before,
      version: draft.version,
      model: draft.analysisModel ?? effectiveModel,
      ...(requestedEffort ? { effort: requestedEffort } : {}),
      locale,
      instruction: text,
      previousTurns: turns.slice(-3).map(({ instruction, note }) => ({ instruction, note })),
    });
    if (!input.success) return false;
    const controller = new AbortController();
    const current = ++generation.current;
    request.current = controller;
    setPreparing('revision');
    setError(undefined);
    try {
      const result = await revision.mutateAsync({ ...input.data, signal: controller.signal });
      if (controller.signal.aborted || current !== generation.current) return false;
      const next = { groups: result.groups, excludedUnitIds: result.excludedUnitIds };
      const changed = JSON.stringify(before) !== JSON.stringify(next);
      const touched = new Set(touchedUnits.current);
      const wasEdited = userEdited.current;
      if (changed) applyEdit(next);
      const turn = {
        id: crypto.randomUUID(),
        instruction: input.data.instruction,
        note: result.note,
        before,
        after: editedPlan.current,
        touched,
        wasEdited,
      };
      setTurns((history) => [...history.slice(-7), turn]);
      return true;
    } catch (cause) {
      if (controller.signal.aborted || current !== generation.current) return false;
      setError(cause);
      if (errorCode(cause) === 'GIT_PLAN_STALE') setStale(true);
      return false;
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPreparing(false);
      }
    }
  }

  function undoRevision() {
    if (!canUndo || !lastEdit || executing.current || request.current || validatingRequest.current)
      return;
    applyEdit(lastEdit.before);
    touchedUnits.current = lastEdit.touched;
    userEdited.current = lastEdit.wasEdited;
    setTurns((history) => history.slice(0, history.indexOf(lastEdit)));
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

  async function confirm(fromSummary = false) {
    const input =
      checked?.input ??
      (fromSummary && canConfirmSummary && summaryInput?.success ? summaryInput.data : undefined);
    if (
      !visible.current ||
      !input ||
      stale ||
      executing.current ||
      validatingRequest.current ||
      request.current
    )
      return;
    executing.current = true;
    setConfirming(true);
    onBusy(true);
    setError(undefined);
    operationId.current ??= crypto.randomUUID();
    try {
      const prepared = checked ?? { input, result: await validation.mutateAsync(input) };
      if (!checked) setChecked(prepared);
      const result = await submission.mutateAsync({
        ...prepared.input,
        operationId: operationId.current,
        digest: prepared.result.digest,
      });
      setReceipt(result.commits);
      visible.current = false;
      setOpen(false);
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError && cause.code === 'GIT_PLAN_STALE') setStale(true);
    } finally {
      executing.current = false;
      setConfirming(false);
      onBusy(false);
    }
  }

  return {
    open,
    manual,
    draft,
    groups: plan.groups,
    excludedUnitIds: plan.excludedUnitIds,
    checked,
    error,
    stale,
    receipt,
    preparing,
    model,
    effort,
    defaultModel,
    preferencesLoading: preferences.isPending,
    preferencesSaving: savePreferences.isPending,
    preferencesError: preferences.isError,
    preferencesSaveError: savePreferences.isError,
    retryPreferences: () => void preferences.refetch(),
    retrySavePreferences: () => {
      if (preferences.data) savePreferences.mutate(preferences.data);
    },
    analyzedModel: draft?.analysisModel,
    catalog,
    modelUnavailable,
    canAnalyze,
    canResume,
    analysisAction,
    instruction,
    setInstruction,
    canRevise,
    revise,
    turns,
    details,
    setDetails,
    canUndo,
    undoRevision,
    canConfirmSummary,
    confirmSummary: () => confirm(true),
    analysisProgress: progress.data?.progress,
    attempted,
    showEditor,
    groupLimitReached,
    openEditor: () => setEditing(true),
    selectModel,
    selectEffort,
    validating,
    committing: confirming,
    start: () => start('ai'),
    startManual: () => start('manual'),
    close,
    analyze,
    refreshSnapshot,
    update,
    preview,
    confirm: () => confirm(),
  };
}
