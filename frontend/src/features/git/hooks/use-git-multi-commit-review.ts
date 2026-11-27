/**
 * @file 管理手动及 AI 多提交计划的分析、对话修改、预览和确认状态。
 * @implementation 拆出模型偏好选择后以单一互斥阶段与错误处理器驱动快照、分析、改写、校验与提交，并保留现有外部返回契约。
 * @updated 2026-11-27T21:45:00+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { useUiTranslation } from '@/i18n';
import { gatewayModelSchema } from '@shared/models';
import { useDraftMultiCommit } from '@/use-query/git/use-draft-multi-commit';
import { useReviseMultiCommit } from '@/use-query/git/use-revise-multi-commit';
import { useCommitAnalysisProgress } from '@/use-query/git/use-commit-analysis-progress';
import { useValidateMultiCommit } from '@/use-query/git/use-validate-multi-commit';
import { useSubmitMultiCommit } from '@/use-query/git/use-submit-multi-commit';
import {
  MAX_MULTI_COMMIT_GROUPS,
  multiCommitValidate,
  multiCommitRevisionRequest,
  multiCommitInstruction,
  type MultiCommitDraft,
  type MultiCommitDraftRequest,
  type MultiCommitGroup,
  type MultiCommitPreview,
  type MultiCommitValidate,
} from '@shared/git-multi-commit';
import { useGitMultiCommitModelSelection } from './use-git-multi-commit-model-selection';

type EditedPlan = { groups: MultiCommitGroup[]; excludedUnitIds: string[] };
type CheckedPlan = { input: MultiCommitValidate; result: MultiCommitPreview };
type Attempt = Required<Pick<MultiCommitDraftRequest, 'analysisId' | 'locale' | 'model'>> &
  Pick<MultiCommitDraftRequest, 'effort' | 'instruction'>;
type AnalysisAction = 'start' | 'retry' | 'continue' | 'finalize' | 'check';
type BusyPhase = 'idle' | 'snapshot' | 'analysis' | 'revision' | 'validating' | 'committing';
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
  const abortController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const busyPhaseRef = useRef<BusyPhase>('idle');
  const operationId = useRef<string | undefined>(undefined);
  const [busyPhase, setBusyPhase] = useState<BusyPhase>('idle');
  const [open, setOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [draft, setDraft] = useState<MultiCommitDraft>();
  const [plan, setPlan] = useState<EditedPlan>({ groups: [], excludedUnitIds: [] });
  const [checked, setChecked] = useState<CheckedPlan>();
  const [error, setError] = useState<unknown>();
  const [receipt, setReceipt] = useState<string[]>();
  const [stale, setStale] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [turns, setTurns] = useState<RevisionTurn[]>([]);
  const [details, setDetails] = useState(false);
  const [attempt, setAttempt] = useState<Attempt>();
  const [attempted, setAttempted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [groupLimitReached, setGroupLimitReached] = useState(false);
  const visible = useRef(false);
  const editedPlan = useRef(plan);
  const touchedUnits = useRef(new Set<string>());
  const userEdited = useRef(false);

  const isBusy = () => busyPhaseRef.current !== 'idle';
  const currentAnalysis =
    attempt && draft?.analysis?.id === attempt.analysisId ? draft.analysis : undefined;

  const modelSelection = useGitMultiCommitModelSelection({
    catalogEnabled: open && !manual,
    isBusy,
    shouldResetAttempt:
      currentAnalysis?.state === 'partial' && currentAnalysis.completedBatchCount === 0,
    onResetAttempt: () => {
      setAttempt(undefined);
      setRecovering(false);
    },
  });

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
    modelSelection.preferencesReady &&
    analysisAction &&
    (canResume ||
      (modelSelection.modelValid &&
        !modelSelection.modelUnavailable &&
        !modelSelection.unsupportedEffort &&
        !(modelSelection.catalog.isFetching && !modelSelection.catalog.data))),
  );
  const progress = useCommitAnalysisProgress(
    projectId,
    treeId,
    open && busyPhase === 'analysis' && analysisAction !== 'check' && attempt && draft
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
    gatewayModelSchema.shape.id.safeParse(draft?.analysisModel ?? modelSelection.effectiveModel)
      .success;
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
      abortController.current?.abort();
    },
    [],
  );

  function handlePlanError(cause: unknown) {
    if (errorCode(cause) === 'GIT_PLAN_STALE') setStale(true);
    setError(cause);
  }

  async function runExclusive<T>(
    phase: Exclude<BusyPhase, 'idle'>,
    options: { abortable?: boolean; notifyHostBusy?: boolean } = {},
    work: (context: { signal?: AbortSignal; currentGeneration: number }) => Promise<T>,
  ): Promise<T | undefined> {
    if (isBusy()) return undefined;
    const controller = options.abortable ? new AbortController() : undefined;
    const currentGeneration = ++generation.current;
    if (controller) abortController.current = controller;
    busyPhaseRef.current = phase;
    setBusyPhase(phase);
    if (options.notifyHostBusy) onBusy(true);
    setError(undefined);
    try {
      return await work({ signal: controller?.signal, currentGeneration });
    } finally {
      if (controller && abortController.current === controller) abortController.current = null;
      if (options.abortable || currentGeneration === generation.current || options.notifyHostBusy) {
        if (busyPhaseRef.current === phase) {
          busyPhaseRef.current = 'idle';
          setBusyPhase('idle');
        }
      }
      if (options.notifyHostBusy) onBusy(false);
    }
  }

  async function prepare(
    kind: 'snapshot' | 'analysis',
    load: (signal: AbortSignal) => Promise<MultiCommitDraft>,
  ) {
    if (!visible.current || isBusy()) return;
    await runExclusive(kind, { abortable: true }, async ({ signal, currentGeneration }) => {
      if (!signal) return;
      try {
        const next = await load(signal);
        if (signal.aborted || currentGeneration !== generation.current) return;
        if (kind === 'analysis') setAttempted(true);
        setRecovering(false);
        if (
          kind === 'snapshot' ||
          !(next.analysis?.canResume || next.analysis?.state === 'running')
        )
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
            .map((group) => ({
              ...group,
              unitIds: group.unitIds.filter((id) => !occupied.has(id)),
            }))
            .filter((group) => group.unitIds.length > 0);
          const capacity = Math.max(0, MAX_MULTI_COMMIT_GROUPS - previous.groups.length);
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
        if (signal.aborted || currentGeneration !== generation.current) return;
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
        handlePlanError(cause);
      }
    });
  }

  function refreshSnapshot() {
    return prepare('snapshot', (signal) =>
      preparation.mutateAsync({ locale, generate: false, signal }),
    );
  }

  function analyze() {
    if (!canAnalyze || !draft || isBusy()) return;
    const parsedModel = gatewayModelSchema.shape.id.safeParse(modelSelection.effectiveModel);
    const resume = canResume && attempt !== undefined;
    const requirement = multiCommitInstruction.safeParse(instruction);
    const active = resume
      ? attempt
      : parsedModel.success
        ? {
            analysisId: crypto.randomUUID(),
            model: parsedModel.data,
            locale,
            ...(modelSelection.requestedEffort ? { effort: modelSelection.requestedEffort } : {}),
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
    if (visible.current || isBusy()) return;
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
    if (busyPhaseRef.current === 'committing') return;
    visible.current = false;
    generation.current++;
    abortController.current?.abort();
    abortController.current = null;
    busyPhaseRef.current = 'idle';
    setBusyPhase('idle');
    setOpen(false);
  }

  function update(groups: MultiCommitGroup[], excludedUnitIds: string[]) {
    if (isBusy()) return;
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
    if (!canRevise || !draft || !visible.current || isBusy()) return false;
    const before = editedPlan.current;
    const input = multiCommitRevisionRequest.safeParse({
      ...before,
      version: draft.version,
      model: draft.analysisModel ?? modelSelection.effectiveModel,
      ...(modelSelection.requestedEffort ? { effort: modelSelection.requestedEffort } : {}),
      locale,
      instruction: text,
      previousTurns: turns.slice(-3).map(({ instruction, note }) => ({ instruction, note })),
    });
    if (!input.success) return false;
    const outcome = await runExclusive(
      'revision',
      { abortable: true },
      async ({ signal, currentGeneration }) => {
        if (!signal) return false;
        try {
          const result = await revision.mutateAsync({ ...input.data, signal });
          if (signal.aborted || currentGeneration !== generation.current) return false;
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
          if (signal.aborted || currentGeneration !== generation.current) return false;
          handlePlanError(cause);
          return false;
        }
      },
    );
    return outcome ?? false;
  }

  function undoRevision() {
    if (!canUndo || !lastEdit || isBusy()) return;
    applyEdit(lastEdit.before);
    touchedUnits.current = lastEdit.touched;
    userEdited.current = lastEdit.wasEdited;
    setTurns((history) => history.slice(0, history.indexOf(lastEdit)));
  }

  async function preview() {
    if (!visible.current || !draft || stale || isBusy()) return;
    const parsed = multiCommitValidate.safeParse({ version: draft.version, ...plan });
    if (!parsed.success) return;
    await runExclusive('validating', {}, async ({ currentGeneration }) => {
      try {
        const result = await validation.mutateAsync(parsed.data);
        if (currentGeneration === generation.current) {
          setChecked({ input: parsed.data, result });
        }
      } catch (cause) {
        if (currentGeneration !== generation.current) return;
        handlePlanError(cause);
      }
    });
  }

  async function confirm(fromSummary = false) {
    const input =
      checked?.input ??
      (fromSummary && canConfirmSummary && summaryInput?.success ? summaryInput.data : undefined);
    if (!visible.current || !input || stale || isBusy()) return;
    const currentOperationId = (operationId.current ??= crypto.randomUUID());
    await runExclusive('committing', { notifyHostBusy: true }, async () => {
      try {
        const prepared = checked ?? { input, result: await validation.mutateAsync(input) };
        if (!checked) setChecked(prepared);
        const result = await submission.mutateAsync({
          ...prepared.input,
          operationId: currentOperationId,
          digest: prepared.result.digest,
        });
        setReceipt(result.commits);
        visible.current = false;
        setOpen(false);
      } catch (cause) {
        handlePlanError(cause);
      }
    });
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
    preparing:
      busyPhase === 'snapshot' || busyPhase === 'analysis' || busyPhase === 'revision'
        ? busyPhase
        : false,
    model: modelSelection.model,
    effort: modelSelection.effort,
    defaultModel: modelSelection.defaultModel,
    preferencesLoading: modelSelection.preferencesLoading,
    preferencesSaving: modelSelection.preferencesSaving,
    preferencesError: modelSelection.preferencesError,
    preferencesSaveError: modelSelection.preferencesSaveError,
    retryPreferences: modelSelection.retryPreferences,
    retrySavePreferences: modelSelection.retrySavePreferences,
    analyzedModel: draft?.analysisModel,
    catalog: modelSelection.catalog,
    modelUnavailable: modelSelection.modelUnavailable,
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
    selectModel: modelSelection.selectModel,
    selectEffort: modelSelection.selectEffort,
    validating: busyPhase === 'validating',
    committing: busyPhase === 'committing',
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
