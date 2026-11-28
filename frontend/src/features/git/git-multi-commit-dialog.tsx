/**
 * @file 展示手动及 AI 多提交的分析、对话审查和详细计划编辑。
 * @implementation 按入口和分析阶段组合模型选择、补充要求与实时进度，在对话摘要和逐组差异编辑之间切换。
 * @updated 2026-11-27T21:55:00+08:00
 */
import { useState } from 'react';
import { GitCommitHorizontal, LoaderCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/api/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { translateError, useUiTranslation } from '@/i18n';
import { cn } from '@/components/ui/utils';
import { commitCredentialBlocksLocal } from '@shared/git-multi-commit';
import { GitPatch } from './git-diff';
import { GitMultiCommitModelPicker } from './git-multi-commit-model-picker';
import { GitMultiCommitConversation } from './git-multi-commit-conversation';
import { GitMultiCommitEditor } from './git-multi-commit-editor';
import type { useGitMultiCommitReview } from './hooks/use-git-multi-commit-review';
import { Textarea } from '@/components/ui/textarea';

export function GitMultiCommitDialog({
  review,
  restoreFocus,
}: {
  review: ReturnType<typeof useGitMultiCommitReview>;
  restoreFocus: () => void;
}) {
  const { t } = useUiTranslation('git');
  const [active, setActive] = useState<string | null>(null);
  const draft = review.draft;
  const progress = review.analysisProgress;
  const analyzing = review.preparing === 'analysis';
  const errorMessage =
    review.error instanceof ApiError && review.error.code === 'MAGPIE_DISABLED'
      ? t('multi.model.magpieDisabled')
      : review.error instanceof ApiError && review.error.code === 'MAGPIE_UNAVAILABLE'
        ? t('multi.model.magpieUnavailable')
        : translateError(review.error, t('errors.failed'));
  const busy = Boolean(review.preparing || review.validating || review.committing);
  const conversational = review.canRevise || review.turns.length > 0;
  const showConversation = conversational && !analyzing && !review.details;
  const picker =
    review.analysisAction === 'start' ||
    review.analysisAction === 'retry' ||
    (review.analysisAction === 'continue' && draft?.analysis?.completedBatchCount === 0);
  const finalizingFailed =
    draft?.analysis?.globalPass === 'pending' &&
    draft.analysis.completedBatchCount === draft.analysis.batchCount;
  const conflict = draft?.units.some((unit) => unit.layer === 'conflict');
  const analysisButton = {
    start: t('multi.analyze'),
    retry: t('multi.retryAnalysis'),
    continue: t('multi.continueAnalysis'),
    finalize: t('multi.retryFinal'),
    check: t('multi.checkAnalysis'),
  };
  const failureText = (reason: string) => {
    switch (reason) {
      case 'input-too-large':
        return t('multi.manualLarge');
      case 'timeout':
        return t('multi.manualTimeout');
      case 'network':
        return t('multi.failureNetwork');
      case 'http':
      case 'invalid-config':
        return t('multi.failureHttp');
      case 'refused':
        return t('multi.failureRefused');
      case 'sensitive-response':
        return t('multi.failureSensitive');
      case 'invalid-response':
        return t('multi.failureResponse');
      case 'invalid-envelope':
        return t('multi.failureEnvelope');
      case 'invalid-json':
        return t('multi.failureJson');
      case 'truncated':
        return t('multi.failureTruncated');
      case 'response-too-large':
        return t('multi.failureResponseLarge');
      case 'unknown-id':
        return t('multi.failureUnknownId');
      case 'duplicate-id':
        return t('multi.failureDuplicateId');
      case 'missing-id':
        return t('multi.failureMissingId');
      case 'group-limit':
        return null;
      default:
        return t('multi.manual');
    }
  };
  const blockedReasons: Readonly<Record<string, string>> = {
    restrictedPath: t('multi.restricted'),
    conflict: t('multi.conflict'),
    rename: t('multi.rename'),
    attributes: t('multi.attributes'),
    indexFlags: t('multi.indexFlags'),
    intentToAdd: t('multi.intentToAdd'),
    unreadable: t('multi.readFailure'),
    tooLarge: t('multi.tooLarge'),
    budget: t('multi.budget'),
    diffLimit: t('multi.diffLimit'),
    copy: t('multi.copy'),
    specialFile: t('multi.specialFile'),
    specialMode: t('multi.specialMode'),
    lineEndings: t('multi.lineEndings'),
  };
  const modelCandidates = new Set(draft?.modelCandidateIds);
  const analyzed = new Set(
    draft?.analysis?.completedUnitIds ??
      (draft?.suggestionStatus === 'ready' ? draft.modelCandidateIds : []),
  );
  const suggested = new Set(draft?.groups.flatMap((group) => group.unitIds));
  const directlyBlocked = new Set(
    draft?.units
      .filter(
        (unit) =>
          unit.kind === 'unsupported' ||
          unit.reason === 'rename' ||
          commitCredentialBlocksLocal(unit.credential),
      )
      .map((unit) => unit.id),
  );
  const units = review.showEditor
    ? draft?.units.map((unit) => {
        const { credential } = unit;
        const location = credential?.location;
        const detail =
          credential && location
            ? t('multi.credential.detail', {
                location:
                  location.kind === 'path'
                    ? t('multi.credential.path')
                    : t(`multi.credential.${location.kind}`, { line: location.line }),
                rule: t(`multi.credential.${credential.rule}`),
              })
            : undefined;
        const blockedReason = directlyBlocked.has(unit.id)
          ? detail && commitCredentialBlocksLocal(credential)
            ? t('multi.credential.blocked', { detail })
            : (blockedReasons[unit.reason ?? ''] ?? t('multi.blockedReason'))
          : unit.dependsOn.some((id) => directlyBlocked.has(id))
            ? t('multi.blockedDependency')
            : undefined;
        return {
          id: unit.id,
          path: unit.path,
          layer: unit.layer,
          reason: unit.reason,
          description:
            unit.kind === 'hunk'
              ? unit.description
              : unit.kind === 'unsupported'
                ? ''
                : unit.reason === 'addition'
                  ? t('multi.atomicAddition')
                  : unit.reason === 'deletion'
                    ? t('multi.atomicDeletion')
                    : unit.reason === 'modeChange'
                      ? t('multi.atomicMode')
                      : unit.reason === 'binary'
                        ? t('multi.atomicBinary')
                        : t('multi.atomicWhole'),
          blockedReason,
          note:
            detail && !commitCredentialBlocksLocal(credential)
              ? t('multi.credential.localOnly', { detail })
              : undefined,
          credential: Boolean(credential),
          analysis: !modelCandidates.has(unit.id)
            ? ('withheld' as const)
            : review.manual
              ? ('manual' as const)
              : !analyzed.has(unit.id)
                ? ('unanalyzed' as const)
                : !suggested.has(unit.id)
                  ? ('modelUnassigned' as const)
                  : ('assigned' as const),
        };
      })
    : undefined;
  return (
    <Dialog
      open={review.open}
      onOpenChange={(open) => {
        if (!open) review.close();
      }}
    >
      <DialogContent
        className={cn(
          'git-commit-dialog git-multi-commit-dialog',
          (!review.showEditor || analyzing) && 'git-multi-commit-intro',
        )}
        showCloseButton={!review.committing}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="git-board-title">
            <GitCommitHorizontal aria-hidden="true" />
            {t(review.manual ? 'multi.manualHeading' : 'multi.heading')}
          </DialogTitle>
          <DialogDescription>
            {t(review.manual ? 'multi.manualDescription' : 'multi.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="git-multi-commit-setup">
          {review.preparing === 'snapshot' ? <p role="status">{t('multi.reading')}</p> : null}
          {draft && !draft.units.length ? <p>{t('multi.noUnits')}</p> : null}
          {draft?.units.length ? (
            <>
              {!review.attempted &&
              !review.showEditor &&
              !review.stale &&
              !analyzing &&
              draft.modelCandidateIds.length ? (
                <div className="git-multi-commit-intro-copy">
                  <p role="status">
                    <strong>{t('multi.notStarted')}</strong>
                  </p>
                  <p>
                    {t('multi.snapshotSummary', {
                      total: draft.units.length,
                      eligible: draft.modelCandidateIds.length,
                    })}
                  </p>
                </div>
              ) : null}
              {!draft.modelCandidateIds.length && !review.showEditor && !review.stale ? (
                <p>{t('multi.noCandidates')}</p>
              ) : null}
              {picker ? (
                <>
                  <GitMultiCommitModelPicker
                    model={review.model}
                    effort={review.effort}
                    defaultModel={review.defaultModel}
                    disabled={busy || review.preferencesLoading || review.preferencesError}
                    onModelChange={review.selectModel}
                    onEffortChange={review.selectEffort}
                  />
                  {review.preferencesLoading ? (
                    <p role="status">{t('multi.model.preferencesLoading')}</p>
                  ) : null}
                  {review.preferencesSaving ? (
                    <p role="status">{t('multi.model.preferencesSaving')}</p>
                  ) : null}
                  {review.preferencesError ? (
                    <p role="alert">
                      {t('multi.model.preferencesLoadFailed')}{' '}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={review.retryPreferences}
                      >
                        {t('board.retry')}
                      </Button>
                    </p>
                  ) : null}
                  {review.preferencesSaveError ? (
                    <p role="alert">
                      {t('multi.model.preferencesSaveFailed')}{' '}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={review.retrySavePreferences}
                      >
                        {t('board.retry')}
                      </Button>
                    </p>
                  ) : null}
                  <p>{t('multi.disclosure')}</p>
                  {!review.canResume ? (
                    <label className="git-commit-conversation-input">
                      {t('multi.conversation.initial')}
                      <Textarea
                        rows={2}
                        maxLength={2000}
                        value={review.instruction}
                        disabled={busy}
                        placeholder={t('multi.conversation.initialPlaceholder')}
                        onChange={(event) => review.setInstruction(event.target.value)}
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
              {analyzing ? (
                <div className="git-multi-commit-live" role="status">
                  <p className="git-multi-commit-progress">
                    <LoaderCircle aria-hidden="true" />
                    {progress?.stage === 'batch'
                      ? t('multi.liveBatch', {
                          current: progress.completedBatchCount + 1,
                          total: progress.batchCount,
                        })
                      : progress?.stage === 'organizing'
                        ? t('multi.liveOrganizing')
                        : progress?.stage === 'finishing'
                          ? t('multi.liveFinishing')
                          : t(
                              review.analysisAction === 'check'
                                ? 'multi.recovering'
                                : 'multi.loading',
                            )}
                  </p>
                  {progress && progress.batchCount > 0 ? (
                    <>
                      <progress
                        aria-label={t('multi.liveLabel')}
                        value={progress.completedBatchCount}
                        max={progress.batchCount}
                      />
                      <p>
                        {t('multi.liveCounts', {
                          ...progress,
                          eligible: draft.modelCandidateIds.length,
                        })}
                      </p>
                    </>
                  ) : null}
                </div>
              ) : review.preparing === false && review.attempted && !review.stale ? (
                <div className="git-multi-commit-result" role="status">
                  {draft.suggestionStatus === 'ready' ? (
                    <strong>
                      {t(draft.groups.length ? 'multi.reviewReady' : 'multi.noSuggestions')}
                    </strong>
                  ) : null}
                  {review.analyzedModel ? (
                    <span>{t('multi.model.analyzedWith', { model: review.analyzedModel })}</span>
                  ) : null}
                  {draft.analysis ? (
                    <>
                      <span>
                        {t('multi.coverage', {
                          ...draft.coverage,
                          eligible: draft.modelCandidateIds.length,
                        })}
                      </span>
                      {draft.analysis.batchCount > 1 ? (
                        <span>
                          {t('multi.analysisProgress', {
                            completed: draft.analysis.completedBatchCount,
                            total: draft.analysis.batchCount,
                          })}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {draft.analysis?.state === 'running' ? (
                    <span>{t('multi.analysisInProgress')}</span>
                  ) : null}
                  {finalizingFailed && draft.analysis?.state !== 'running' ? (
                    <p>{t('multi.finalizingFailed')}</p>
                  ) : null}
                  {draft.suggestionReason &&
                  draft.suggestionReason !== 'manual' &&
                  !review.error ? (
                    <p>{failureText(draft.suggestionReason)}</p>
                  ) : null}
                  {review.groupLimitReached ? <p>{t('multi.groupLimit')}</p> : null}
                </div>
              ) : null}
            </>
          ) : null}
          {review.error && !review.preparing ? (
            <p className="git-multi-commit-setup-error" role="alert">
              {errorMessage}
            </p>
          ) : null}
          <div className="git-multi-commit-setup-actions">
            {review.analysisAction ? (
              <Button
                type="button"
                variant={review.showEditor ? 'outline' : 'default'}
                disabled={busy || !review.canAnalyze}
                onClick={() => void review.analyze()}
              >
                <Sparkles data-icon="inline-start" aria-hidden="true" />
                {analysisButton[review.analysisAction]}
              </Button>
            ) : null}
            {draft?.units.length && !review.showEditor && !review.stale ? (
              <Button type="button" variant="ghost" disabled={busy} onClick={review.openEditor}>
                {t('multi.manualEditor')}
              </Button>
            ) : null}
            {review.stale || conflict || (!draft && review.error) ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void review.refreshSnapshot()}
              >
                {t('multi.refreshSnapshot')}
              </Button>
            ) : null}
          </div>
        </div>
        {conversational ? (
          <GitMultiCommitConversation
            review={review}
            busy={busy}
            hidden={!showConversation}
            onDetails={() => review.setDetails(true)}
          />
        ) : null}
        {conversational && review.details && !analyzing ? (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => review.setDetails(false)}
            >
              {t('multi.conversation.back')}
            </Button>
          </div>
        ) : null}
        {draft && units ? (
          <GitMultiCommitEditor
            hidden={analyzing || showConversation}
            units={units}
            groups={review.groups}
            excludedUnitIds={review.excludedUnitIds}
            activeGroupId={active}
            status={
              review.committing
                ? 'submitting'
                : review.validating
                  ? 'previewing'
                  : review.preparing
                    ? 'loading'
                    : 'ready'
            }
            canConfirm={Boolean(review.checked) && !review.stale}
            previewBlockedReason={
              review.stale ? t('multi.stale') : conflict ? t('multi.conflict') : undefined
            }
            preview={
              review.checked
                ? {
                    groups: review.checked.input.groups,
                    excludedUnitIds: review.checked.input.excludedUnitIds,
                    renderGroupDiff: (group) => {
                      const item = review.checked?.result.groups.find(
                        (entry) => entry.id === group.id,
                      );
                      return item?.files.map((file) => (
                        <div className="git-multi-commit-preview-file" key={file.path}>
                          <code>{file.path}</code>
                          {file.binary ? (
                            <p>{t('multi.binary')}</p>
                          ) : (
                            <GitPatch path={file.path} text={file.text} />
                          )}
                        </div>
                      ));
                    },
                  }
                : null
            }
            onGroupsChange={(groups, excluded) =>
              review.update(
                groups.map((group) => ({ ...group, unitIds: [...group.unitIds] })),
                [...excluded],
              )
            }
            onActiveGroupChange={setActive}
            onAddGroup={() => {
              const id = crypto.randomUUID();
              review.update(
                [...review.groups, { id, title: '', body: '', unitIds: [] }],
                review.excludedUnitIds,
              );
              setActive(id);
            }}
            onPreview={() => void review.preview()}
            onConfirm={() => void review.confirm()}
            onCancel={review.close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
