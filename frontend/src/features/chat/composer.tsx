/**
 * @file 提供任务输入、文本增强、引用、附件编辑和运行停止操作。
 * @implementation 管理输入、发送锁和运行操作。编辑或发送时取消增强，写回前复核当前草稿。
 * @updated 2026-11-28T17:50:11+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ArrowUp, Paperclip, Plus } from 'lucide-react';
import { composerTextLimit, formatMessageText } from '@shared/message-quotes';
import type { Draft, ReasoningEffort, Run } from '@shared/types';
import { attachmentAccept } from '@/use-query/attachments/use-upload-attachment';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { ExtensionPicker, type ExtensionPickerHandle } from '@/features/extensions/picker';
import type { SessionSkillScope } from '@/use-query/skill-inheritance/keys';
import { DraftSessionSkills, SessionSkillsControl } from '@/features/extensions/session-skills';
import { stagedAttachment } from './staged-attachments';
import { useSessionSkills } from '@/features/extensions/use-session-skills';
import { ComposerContextChips, ComposerQuotes } from './composer-context';
import { composerErrorText, type ComposerError } from './composer-errors';
import { selectComposerPolicy } from './composer-policy';
import { ContextPicker } from './context-picker';
import { selectContextUsage } from './context-usage-model';
import { ContextUsagePopover } from './context-usage-popover';
import { ComposerModeSelector } from './mode-selector';
import { ModelPicker } from './model-picker';
import type { ComposerMode } from './run-mode';
import { TaskPlan } from './task-plan';
import { useComposerKeymap } from './use-composer-keymap';

import { useComposerAttachments, type DraftChange } from './hooks/use-composer-attachments';
import { Textarea } from '@/components/ui/textarea';
import { TextEnhanceAction } from '@/features/text-enhancement/text-enhance-action';
import { useTextEnhancement } from '@/features/text-enhancement/use-text-enhancement';

export type { DraftChange } from './hooks/use-composer-attachments';
const modeFooter = {
  native: 'composer.nativeFooter',
  automatic: 'composer.automaticFooter',
  edit: 'composer.controlledFooter',
  readonly: 'composer.readonlyFooter',
} as const satisfies Record<ComposerMode, string>;

export function Composer({
  snapshot,
  newSession = false,
  draft,
  taskPlanRun,
  inputRef: externalInputRef,
  editingMessage = false,
  draftActionError = '',
  onRemoveQuote,
  defaultModel,
  nativeExecution = false,
  onModelChange,
  onEffortChange,
  onModeChange,
  onDraftChange,
  getDraft,
  onSend,
  onStop,
  stopPendingRunId,
  submitting,
}: {
  snapshot: Snapshot;
  newSession?: boolean;
  draft: Draft;
  taskPlanRun?: Run;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  editingMessage?: boolean;
  draftActionError?: string;
  onRemoveQuote: (id: string) => void;
  defaultModel: string;
  nativeExecution?: boolean;
  onModelChange: (model?: string) => void;
  onEffortChange: (effort?: ReasoningEffort) => void;
  onModeChange: (mode: ComposerMode) => void;
  onDraftChange: DraftChange;
  getDraft: () => Draft;
  onSend: (insertIntoRunId?: string) => Promise<void>;
  onStop: (runId: string) => void;
  stopPendingRunId?: string;
  submitting: boolean;
}) {
  const { t } = useUiTranslation('chat');
  const [input, setInput] = useState<HTMLTextAreaElement | null>(null);
  const bindInput = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (externalInputRef) externalInputRef.current = element;
      setInput(element);
    },
    [externalInputRef],
  );
  const pickerKeyHandlerRef = useRef<ExtensionPickerHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sendLock = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState<ComposerError>();
  const errorText = composerErrorText(error, t);
  const sessionId = snapshot.session.id;
  const agent = snapshot.agent;
  const {
    archived,
    nativeAvailable,
    readonlyProfile,
    mode,
    contextAllowed,
    attachmentsAllowed,
    directoryAvailable,
    run,
    hasQueuedMessages,
    queueing,
    insertRunId,
  } = selectComposerPolicy(snapshot, draft, nativeExecution);
  const skillsDisabled = archived || submitting;
  const skillMode = mode === 'native' || mode === 'automatic' ? mode : 'controlled';
  const skillScope: SessionSkillScope = newSession
    ? { type: 'draft', projectId: snapshot.project.id, mode: skillMode }
    : { type: 'session', projectId: snapshot.project.id, sessionId, mode: skillMode };
  const sessionSkills = useSessionSkills({
    scope: skillScope,
    selections: draft.extensionSelections,
    disabled: skillsDisabled,
    onDraftChange,
  });
  const stopping = run !== undefined && (run.status === 'stopping' || run.id === stopPendingRunId);
  const sendLabel = queueing ? t('composer.queue') : t('composer.sendTask');
  const quoteTooLong =
    Boolean(draft.messageQuotes?.length) &&
    formatMessageText(draft.text, draft.messageQuotes).length > composerTextLimit;
  const {
    uploads,
    removing,
    pendingOperations,
    busy,
    canUpload,
    queueUpload,
    removeAttachment,
    dismissUpload,
  } = useComposerAttachments({
    sessionId,
    newSession,
    draft,
    onDraftChange,
    attachmentsAllowed,
    archived,
    submitting,
    onError: (error) => setError({ type: 'attachment', error }),
  });
  const enhancement = useTextEnhancement({
    target: sessionId,
    kind: 'instruction',
    text: draft.text,
    disabled: archived || submitting,
    onReplace(expected, text) {
      if (sendLock.current || getDraft().text !== expected) return false;
      onDraftChange((previous) => ({ ...previous, text }));
      return true;
    },
  });
  const dropAllowed = canUpload && draft.attachmentIds.length < 20;
  const canSend =
    !archived &&
    directoryAvailable &&
    !submitting &&
    !busy &&
    !agent?.issues.length &&
    !quoteTooLong &&
    Boolean(draft.text.trim());
  const keymap = useComposerKeymap({
    insertRunId,
    consumeCompletion: (event) => pickerKeyHandlerRef.current?.handleKeyDown(event) ?? false,
    onSubmit: (runId) => void submit(runId),
  });

  useLayoutEffect(() => {
    if (CSS.supports('field-sizing', 'content')) return;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [input, draft.text]);

  async function submit(insertIntoRunId?: string) {
    if (!canSend || pendingOperations.current || sendLock.current) return;
    sendLock.current = true;
    enhancement.cancel();
    setError(undefined);
    try {
      await onSend(insertIntoRunId);
    } catch (failure) {
      setError({ type: 'send', cause: failure });
    } finally {
      sendLock.current = false;
    }
  }

  return (
    <form
      className="composer chat-composer"
      aria-label={t('composer.writeTask')}
      data-file-drag={dragging}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = dropAllowed ? 'copy' : 'none';
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (!canUpload || pendingOperations.current) {
          setError({
            type: 'notice',
            key: !attachmentsAllowed ? 'composer.attachmentsDisabled' : 'composer.dropBusy',
          });
          return;
        }
        queueUpload(event.dataTransfer.files);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {agent?.issues.length ? (
        <p className="text-sm text-destructive" role="status">
          {t('composer.agentIssues', {
            issues: agent.issues.join(t('composer.issueSeparator')),
          })}
          {agent.canUpgrade ? t('composer.upgradeAgent') : t('composer.checkAgent')}
        </p>
      ) : null}
      {agent?.starters.length && !snapshot.messages.length && !archived ? (
        <div className="composer-starters" aria-label={t('composer.starters')}>
          {agent.starters.map((starter) => (
            <Button
              key={starter}
              size="sm"
              variant="outline"
              className="composer-starter-btn"
              onClick={() => {
                enhancement.cancel();
                onDraftChange((previous) => ({ ...previous, text: starter }));
                input?.focus();
              }}
            >
              {starter}
            </Button>
          ))}
        </div>
      ) : null}
      {taskPlanRun ? (
        <TaskPlan
          key={taskPlanRun.id}
          steps={taskPlanRun.plan}
          defaultOpen={
            taskPlanRun.plan.length <= 3 &&
            taskPlanRun.plan.some((step) => step.status !== 'completed')
          }
        />
      ) : null}
      <div className="composer-box">
        <p id="composer-mode-help" className="sr-only">
          {readonlyProfile
            ? t('composer.readonlyAgentHelp')
            : mode === 'native'
              ? t('composer.nativeHelp')
              : mode === 'automatic'
                ? t('composer.automaticHelp')
                : mode === 'edit'
                  ? t('composer.controlledHelp')
                  : t('composer.readonlyHelp')}
        </p>
        <ComposerContextChips
          contextPaths={draft.contextPaths}
          attachmentIds={draft.attachmentIds}
          stagedAttachments={
            newSession
              ? new Map(
                  draft.attachmentIds.map((id) => [
                    id,
                    stagedAttachment(sessionId, id)?.file.name ?? id,
                  ]),
                )
              : undefined
          }
          attachments={snapshot.attachments}
          uploads={uploads}
          removing={removing}
          disabled={archived || submitting}
          onRemoveContext={(path) =>
            onDraftChange((previous) => ({
              ...previous,
              contextPaths: previous.contextPaths.filter((value) => value !== path),
            }))
          }
          onRemoveAttachment={removeAttachment}
          onDismissUpload={dismissUpload}
        />
        <label
          className={cn('composer-label', !archived && !editingMessage && 'sr-only')}
          htmlFor="prompt-input"
        >
          {archived
            ? t('composer.archivedLabel')
            : editingMessage
              ? t('composer.editingLabel')
              : t('composer.continue')}
        </label>
        {editingMessage ? (
          <p id="composer-edit-help" className="composer-edit-help">
            {t('composer.editHelp')}
          </p>
        ) : null}
        <ComposerQuotes
          quotes={draft.messageQuotes}
          disabled={archived || submitting}
          onRemoveQuote={onRemoveQuote}
        />
        <Textarea
          ref={bindInput}
          id="prompt-input"
          rows={1}
          maxLength={composerTextLimit}
          value={draft.text}
          disabled={archived}
          readOnly={newSession && submitting}
          aria-invalid={quoteTooLong || undefined}
          aria-keyshortcuts={insertRunId ? 'Control+Enter Alt+Enter' : undefined}
          aria-describedby={
            editingMessage
              ? 'input-help chat-composer-error composer-edit-help'
              : 'input-help chat-composer-error'
          }
          placeholder={t('composer.placeholder')}
          title={t('composer.inputHint')}
          onCompositionStart={keymap.onCompositionStart}
          onCompositionEnd={keymap.onCompositionEnd}
          onKeyDown={keymap.onKeyDown}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
              .filter((file) => file.type === 'image/png' || file.type === 'image/jpeg')
              .map(
                (file, index) =>
                  new File(
                    [file],
                    t('composer.screenshotName', {
                      timestamp: Date.now(),
                      number: index + 1,
                      extension: file.type === 'image/png' ? 'png' : 'jpg',
                    }),
                    { type: file.type },
                  ),
              );
            if (!files.length) return;
            if (!event.clipboardData.getData('text/plain')) event.preventDefault();
            if (
              !attachmentsAllowed ||
              archived ||
              submitting ||
              busy ||
              pendingOperations.current
            ) {
              setError({
                type: 'notice',
                key: !attachmentsAllowed ? 'composer.attachmentsDisabled' : 'composer.pasteBusy',
              });
              return;
            }
            queueUpload(files);
          }}
          onChange={(event) => {
            enhancement.cancel();
            const text = event.target.value;
            onDraftChange((previous) => ({ ...previous, text }));
          }}
        />
        <fieldset className="chat-extension-fieldset" disabled={archived || submitting}>
          <legend className="sr-only">{t('composer.extensions')}</legend>
          <DraftSessionSkills skills={sessionSkills} disabled={skillsDisabled} />
          <ExtensionPicker
            projectId={archived ? undefined : snapshot.project.id}
            agent={agent}
            sessionId={snapshot.workspace ? sessionId : undefined}
            skillScope={skillScope}
            sessionSkillIds={sessionSkills.draftSkillIds}
            contextAllowed={contextAllowed && directoryAvailable}
            draft={draft}
            selectionMode={mode === 'readonly' ? 'readonly' : 'edit'}
            onChange={(patch) => {
              if (!skillsDisabled) onDraftChange((previous) => ({ ...previous, ...patch }));
            }}
            input={input}
            composing={keymap.composing}
            keyHandlerRef={pickerKeyHandlerRef}
          />
        </fieldset>
        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="composer-action-btn"
              aria-label={t('composer.context')}
              title={t('context.title')}
              disabled={!contextAllowed || archived || submitting || !directoryAvailable}
              onClick={() => setContextOpen(true)}
            >
              <Plus aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="composer-action-btn attach-button"
              disabled={
                !attachmentsAllowed ||
                archived ||
                submitting ||
                busy ||
                draft.attachmentIds.length >= 20
              }
              aria-label={t('composer.upload')}
              title={t('composer.uploadHint')}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip data-icon="inline-start" aria-hidden="true" />
            </Button>
            <TextEnhanceAction action={enhancement} />
            <SessionSkillsControl
              compact
              canChangePolicy={!newSession}
              skills={sessionSkills}
              activeRun={run?.startedAt ? run : undefined}
              disabled={skillsDisabled}
              selectionCount={draft.extensionSelections?.length ?? 0}
            />
            <ComposerModeSelector
              mode={mode}
              nativeExecution={nativeAvailable}
              readonlyProfile={readonlyProfile}
              disabled={archived || submitting}
              onModeChange={onModeChange}
            />
          </div>
          <div className="composer-toolbar-right">
            <span
              className="composer-run-status"
              data-status={stopping ? 'stopping' : run?.status}
              role="status"
            >
              {dragging ? (
                dropAllowed ? (
                  t('composer.dropToAdd')
                ) : (
                  t('composer.cannotAdd')
                )
              ) : submitting ? (
                t('composer.sending')
              ) : busy ? (
                t('composer.processingAttachments')
              ) : stopping ? (
                t('composer.stoppingStatus')
              ) : run ? (
                run.status === 'running' ? (
                  <span className="sr-only">{t('composer.running')}</span>
                ) : (
                  (
                    {
                      queued: t('composer.queued'),
                      awaiting_permission: t('composer.awaitingPermission'),
                    } as Record<string, string>
                  )[run.status]
                )
              ) : (
                ''
              )}
            </span>
            {run ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="composer-stop-button"
                data-status={stopping ? 'stopping' : run.status}
                disabled={stopping}
                onClick={() => onStop(run.id)}
              >
                <span
                  className="composer-stop-icon-wrapper"
                  data-icon="inline-start"
                  aria-hidden="true"
                >
                  <svg className="composer-stop-spinner" viewBox="0 0 16 16">
                    <circle className="composer-stop-track" cx="8" cy="8" r="6" />
                    <circle className="composer-stop-indicator" cx="8" cy="8" r="6" />
                  </svg>
                  <span className="composer-stop-square" />
                </span>
                {stopping
                  ? t('composer.stopping')
                  : hasQueuedMessages
                    ? t('composer.stopTurn')
                    : t('composer.stop')}
              </Button>
            ) : null}
            <ContextUsagePopover
              sample={selectContextUsage(
                snapshot.runs,
                snapshot.session.sdkSessionId,
                run?.id,
                draft.model ?? defaultModel,
              )}
              running={Boolean(run)}
              hasRuns={snapshot.runs.length > 0}
            />
            <ModelPicker
              compact
              model={draft.model}
              effort={draft.effort}
              defaultModel={defaultModel}
              disabled={archived || submitting}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
            />
            <Button
              type="submit"
              size="icon"
              className="composer-send-button shrink-0"
              disabled={!canSend}
              aria-label={sendLabel}
              title={t('composer.sendTask') + (insertRunId ? t('composer.insertShortcut') : '')}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      <p id="input-help" className="sr-only">
        {t('composer.keyboardHelp', {
          action: t(queueing ? 'composer.queueAction' : 'composer.sendAction'),
          insertHelp: insertRunId ? t('composer.insertShortcut') : '',
        })}{' '}
        {t('composer.inputHint')} {t(modeFooter[mode])}
      </p>
      <p id="chat-composer-error" className="chat-composer-error" role="alert">
        {draftActionError ||
          (quoteTooLong ? t('composer.quoteTooLong') : '') ||
          errorText ||
          (archived
            ? t('composer.archivedError')
            : !snapshot.workspace && !directoryAvailable
              ? t('composer.projectUnavailable')
              : '')}
      </p>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={attachmentAccept}
        hidden
        onChange={(event) => {
          queueUpload(event.target.files);
          event.target.value = '';
        }}
      />
      {contextOpen && !archived && !submitting && directoryAvailable ? (
        <ContextPicker
          projectId={snapshot.project.id}
          sessionId={snapshot.workspace ? sessionId : undefined}
          selectedPaths={draft.contextPaths}
          onSelect={(path) =>
            onDraftChange((previous) => ({
              ...previous,
              contextPaths: [...new Set([...previous.contextPaths, path])],
            }))
          }
          onClose={() => {
            setContextOpen(false);
            input?.focus();
          }}
        />
      ) : null}
    </form>
  );
}
