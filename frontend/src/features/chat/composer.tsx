/**
 * @file 提供任务输入、引用和附件编辑。
 * @implementation 按会话管理草稿、附件、上下文和发送。输入框优先使用浏览器原生自动高度，并兼容旧浏览器。
 * @updated 2026-11-27T00:33:30+08:00
 */
import { useUiTranslation, translateError } from '@/i18n';
import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { ArrowUp, File as FileIcon, Paperclip, Plus, Quote, X } from 'lucide-react';
import { composerTextLimit, fileQuoteLocation, formatMessageText } from '@shared/message-quotes';
import type { Draft, ReasoningEffort, Run } from '@shared/types';
import { attachmentAccept } from '@/use-query/attachments/use-upload-attachment';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { ExtensionPicker } from '@/features/extensions/picker';
import { mergePickerSelections } from '@/features/extensions/inheritance-model';
import { DraftSessionSkills, SessionSkillsControl } from '@/features/extensions/session-skills';
import { useSessionSkills } from '@/features/extensions/use-session-skills';
import { AttachmentPreview } from './attachment-preview';
import { ContextPicker } from './context-picker';
import { selectContextUsage } from './context-usage-model';
import { ContextUsagePopover } from './context-usage-popover';
import { isActive } from './conversation';
import { ComposerModeSelector } from './mode-selector';
import { ModelPicker } from './model-picker';
import { composerMode, type ComposerMode } from './run-mode';
import { TaskPlan } from './task-plan';

import {
  useComposerAttachments,
  type AttachmentActionError,
  type DraftChange,
} from './hooks/use-composer-attachments';

export type { DraftChange } from './hooks/use-composer-attachments';
type ComposerError =
  | { type: 'attachment'; error: AttachmentActionError }
  | { type: 'send'; cause: unknown }
  | {
      type: 'notice';
      key: 'composer.attachmentsDisabled' | 'composer.dropBusy' | 'composer.pasteBusy';
    };

const modeFooter = {
  native: 'composer.nativeFooter',
  automatic: 'composer.automaticFooter',
  edit: 'composer.controlledFooter',
  readonly: 'composer.readonlyFooter',
} as const satisfies Record<ComposerMode, string>;

export function Composer({
  snapshot,
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
  onSend,
  onStop,
  submitting,
}: {
  snapshot: Snapshot;
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
  onSend: (insertIntoRunId?: string) => Promise<void>;
  onStop: (runId: string) => void;
  submitting: boolean;
}) {
  const { t } = useUiTranslation('chat');
  const localInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = externalInputRef ?? localInputRef;
  const fileInput = useRef<HTMLInputElement>(null);
  const sendLock = useRef(false);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [error, setError] = useState<ComposerError>();
  const errorText = error
    ? error.type === 'notice'
      ? t(error.key)
      : error.type === 'send'
        ? translateError(error.cause, t('composer.sendUnconfirmed'))
        : error.error.type === 'limit'
          ? t('attachment.limit')
          : translateError(error.error.cause, t('attachment.removeFailed'))
    : '';
  const sessionId = snapshot.session.id;
  const agent = snapshot.agent;
  const nativeAvailable = nativeExecution && !agent && !snapshot.session.agentRevisionId;
  const mode = composerMode(draft, agent?.mode === 'readonly', nativeAvailable);
  const contextAllowed = !agent || agent.capabilities.includes('context');
  const attachmentsAllowed = !agent || agent.capabilities.includes('attachments');
  const archived = snapshot.session.status === 'archived';
  const skillsDisabled = archived || submitting;
  const sessionSkills = useSessionSkills({
    projectId: snapshot.session.projectId,
    sessionId,
    native: mode === 'native',
    selections: draft.extensionSelections,
    disabled: skillsDisabled,
    onDraftChange,
  });
  const run = snapshot.runs.find(isActive);
  const hasQueuedMessages = Boolean(snapshot.messageQueue?.items.length);
  const queueing = Boolean(run || hasQueuedMessages || snapshot.messageQueue?.paused);
  const sendLabel = queueing ? t('composer.queue') : t('composer.sendTask');
  const insertRunId =
    !archived && (run?.status === 'running' || run?.status === 'awaiting_permission')
      ? run.id
      : undefined;
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
    draft,
    onDraftChange,
    attachmentsAllowed,
    archived,
    submitting,
    onError: (error) => setError({ type: 'attachment', error }),
  });
  const dropAllowed = canUpload && draft.attachmentIds.length < 20;
  const directoryAvailable = snapshot.workspace
    ? snapshot.workspace.state === 'ready'
    : snapshot.project.available;
  const canSend =
    !archived &&
    directoryAvailable &&
    !submitting &&
    !busy &&
    !agent?.issues.length &&
    !quoteTooLong &&
    Boolean(draft.text.trim());
  const attachments = new Map(
    snapshot.attachments.map((attachment) => [attachment.id, attachment]),
  );

  useLayoutEffect(() => {
    if (CSS.supports('field-sizing', 'content')) return;
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft.text]);

  async function submit(event?: FormEvent<HTMLFormElement>, insertIntoRunId?: string) {
    event?.preventDefault();
    if (!canSend || pendingOperations.current || sendLock.current) return;
    sendLock.current = true;
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
      onSubmit={(event) => void submit(event)}
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
        <div className="mb-2 flex flex-wrap gap-2" aria-label={t('composer.starters')}>
          {agent.starters.map((starter) => (
            <Button
              key={starter}
              size="sm"
              variant="outline"
              onClick={() => {
                onDraftChange((previous) => ({ ...previous, text: starter }));
                inputRef.current?.focus();
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
          {agent?.mode === 'readonly'
            ? t('composer.readonlyAgentHelp')
            : mode === 'native'
              ? t('composer.nativeHelp')
              : mode === 'automatic'
                ? t('composer.automaticHelp')
                : mode === 'edit'
                  ? t('composer.controlledHelp')
                  : t('composer.readonlyHelp')}
        </p>
        {(draft.contextPaths.length > 0 ||
          draft.attachmentIds.length > 0 ||
          uploads.length > 0) && (
          <div className="composer-chips-bar" aria-label={t('composer.draftContext')}>
            {draft.contextPaths.map((path) => {
              const lastSlash = path.lastIndexOf('/');
              const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
              const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
              return (
                <Button
                  key={path}
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="context-chip"
                  disabled={archived || submitting}
                  aria-label={t('composer.removeContext', { path })}
                  title={path}
                  onClick={() =>
                    onDraftChange((previous) => ({
                      ...previous,
                      contextPaths: previous.contextPaths.filter((value) => value !== path),
                    }))
                  }
                >
                  <FileIcon className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {dir ? <span className="opacity-60 font-mono text-[11px]">{dir}</span> : null}
                    <strong className="font-semibold text-foreground">{name}</strong>
                  </span>
                  <X data-icon="inline-end" aria-hidden="true" />
                </Button>
              );
            })}
            {draft.attachmentIds.map((id) => {
              const item = attachments.get(id);
              const name = item?.name ?? id;
              const isRemoving = removing.includes(id);
              return (
                <div key={id} className="context-chip attachment-chip">
                  {item ? (
                    <AttachmentPreview attachment={item}>
                      <Paperclip data-icon="inline-start" aria-hidden="true" />
                      <span className="truncate" title={name}>
                        {name}
                      </span>
                    </AttachmentPreview>
                  ) : (
                    <span>{name}</span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="attachment-remove"
                    disabled={archived || submitting || isRemoving}
                    aria-label={t('composer.removeAttachment', { name })}
                    title={
                      isRemoving ? t('composer.removing') : t('composer.removeAttachmentTitle')
                    }
                    onClick={() => removeAttachment(id)}
                  >
                    <X data-icon="inline-start" aria-hidden="true" />
                  </Button>
                </div>
              );
            })}
            {uploads.map((entry) =>
              entry.error ? (
                <Button
                  key={entry.id}
                  type="button"
                  variant="outline"
                  size="xs"
                  className="context-chip chat-upload-error"
                  aria-label={t('composer.dismissUpload', { name: entry.name, error: entry.error })}
                  onClick={() => dismissUpload(entry.id)}
                >
                  {t('composer.failedUpload', { name: entry.name, error: entry.error })}
                  <X data-icon="inline-end" aria-hidden="true" />
                </Button>
              ) : (
                <span key={entry.id} className="context-chip" role="status">
                  {t('composer.uploadingFile', { name: entry.name })}
                </span>
              ),
            )}
          </div>
        )}
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
        {draft.messageQuotes?.length ? (
          <ul
            className="composer-quotes"
            aria-label={t(
              draft.messageQuotes.some(({ file }) => file)
                ? 'composer.fileQuotes'
                : 'composer.quotes',
            )}
          >
            {draft.messageQuotes.map((item, index) => (
              <li key={item.id} className="composer-quote">
                <Quote
                  data-icon="inline-start"
                  className="composer-quote-mark"
                  aria-hidden="true"
                />
                {item.file ? (
                  <div className="composer-file-quote">
                    <code
                      className="composer-file-quote-location"
                      title={fileQuoteLocation(item.file)}
                    >
                      {fileQuoteLocation(item.file)}
                    </code>
                    <span className="composer-quote-excerpt">{item.text}</span>
                  </div>
                ) : (
                  <span className="composer-quote-excerpt">{item.text}</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={archived || submitting}
                  aria-label={t('composer.removeQuoteNumber', { number: index + 1 })}
                  title={t('composer.removeQuote')}
                  onClick={() => onRemoveQuote(item.id)}
                >
                  <X data-icon="inline-start" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <textarea
          ref={inputRef}
          id="prompt-input"
          rows={1}
          maxLength={composerTextLimit}
          value={draft.text}
          disabled={archived}
          aria-invalid={quoteTooLong || undefined}
          aria-keyshortcuts={insertRunId ? 'Control+Enter Alt+Enter' : undefined}
          aria-describedby={
            editingMessage
              ? 'input-help chat-composer-error composer-edit-help'
              : 'input-help chat-composer-error'
          }
          placeholder={t('composer.placeholder')}
          title={t('composer.inputHint')}
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
            contextAllowed={contextAllowed && directoryAvailable}
            draft={{
              ...draft,
              mode: mode === 'readonly' ? 'readonly' : 'edit',
              extensionSelections: draft.extensionSelections?.filter(
                ({ id }) => !sessionSkills.dialogSelectionIds.has(id),
              ),
            }}
            onChange={(next: Draft) => {
              if (!skillsDisabled)
                onDraftChange((previous) => ({
                  ...next,
                  mode: previous.mode,
                  approvalMode: previous.approvalMode,
                  executionPreference: previous.executionPreference,
                  extensionSelections: mergePickerSelections(
                    previous.extensionSelections,
                    next.extensionSelections,
                    sessionSkills.dialogSelectionIds,
                  ),
                }));
            }}
            inputRef={inputRef}
            onSubmit={() => void submit()}
            onQuickInsert={insertRunId ? () => void submit(undefined, insertRunId) : undefined}
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
            <SessionSkillsControl
              compact
              skills={sessionSkills}
              activeRun={run?.startedAt ? run : undefined}
              disabled={skillsDisabled}
              selectionCount={draft.extensionSelections?.length ?? 0}
            />
            <ComposerModeSelector
              mode={mode}
              nativeExecution={nativeAvailable}
              readonlyProfile={agent?.mode === 'readonly'}
              disabled={archived || submitting}
              onModeChange={onModeChange}
            />
          </div>
          <div className="composer-toolbar-right">
            <span className="composer-run-status" data-status={run?.status} role="status">
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
              ) : run ? (
                run.status === 'running' ? (
                  <span className="sr-only">{t('composer.running')}</span>
                ) : (
                  (
                    {
                      queued: t('composer.queued'),
                      awaiting_permission: t('composer.awaitingPermission'),
                      stopping: t('composer.stoppingStatus'),
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
                data-status={run.status}
                disabled={run.status === 'stopping'}
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
                {run.status === 'stopping'
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
              className="shrink-0"
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
            inputRef.current?.focus();
          }}
        />
      ) : null}
    </form>
  );
}
