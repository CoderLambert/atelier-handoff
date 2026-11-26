/**
 * @file 组合会话消息、待处理队列、任务清单和输入界面。
 * @implementation 协调清单展示与输入焦点，为对话提供稳定的操作回调，在引用和编辑时读取本会话的最新草稿。
 * @updated 2026-11-27T00:29:54+08:00
 */
import { useUiTranslation } from '@/i18n';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { composerTextLimit, formatMessageText, messageQuoteLimit } from '@shared/message-quotes';
import type { Draft, Message, ReasoningEffort } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { permissionKeys } from '@/use-query/permissions/keys';
import { sessionKeys } from '@/use-query/sessions/keys';
import type { ChatLinkOpener } from './chat-web-link-dialog';
import { Composer, type DraftChange } from './composer';
import { Conversation, isActive } from './conversation';
import { MessageQueue } from './message-queue';
import {
  hasMessageForkAnchor,
  ReplaceDraftDialog,
  RewindMessageDialog,
  rewindUnavailableReason,
} from './message-actions';
import type { ComposerMode } from './run-mode';
import './chat.css';

export interface ChatProps {
  snapshot: Snapshot;
  draft: Draft;
  getDraft: () => Draft;
  defaultModel: string;
  nativeExecution?: boolean;
  onModelChange: (model?: string) => void;
  onEffortChange: (effort?: ReasoningEffort) => void;
  onModeChange: (mode: ComposerMode) => void;
  onDraftChange: DraftChange;
  onSend: (insertIntoRunId?: string) => Promise<void>;
  onStop: (runId: string) => void;
  onRetry: (runId: string) => void;
  onTrace: (runId: string) => void;
  onForkMessage?: (messageId: string) => void;
  onRewindMessage?: (messageId: string, expectedHeadId: string) => Promise<void>;
  forkingMessageId?: string;
  onOpenLink?: ChatLinkOpener;
  submitting: boolean;
}

export default function Chat(props: ChatProps) {
  return <SessionChat key={props.snapshot.session.id} {...props} />;
}

function SessionChat(props: ChatProps) {
  const { t } = useUiTranslation('chat');
  const { snapshot, draft, getDraft, onDraftChange, onRetry, onTrace, onOpenLink, submitting } =
    props;
  const sessionId = snapshot.session.id;
  const { onRewindMessage } = props;
  const currentRun = snapshot.runs.find(isActive) ?? snapshot.runs.at(-1);
  const composerPlan = currentRun?.plan.length ? currentRun : undefined;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [replacement, setReplacement] = useState<{
    sessionId: string;
    text: string;
    trigger: HTMLButtonElement;
  }>();
  const [rewind, setRewind] = useState<{
    message: Message;
    expectedHeadId: string;
    subsequentMessageCount: number;
    trigger: HTMLButtonElement;
  }>();
  const queuePending = useIsMutating({
    mutationKey: sessionKeys.messageQueue(snapshot.session.id),
  });
  const approvalPending = useIsMutating({ mutationKey: permissionKeys.decide });
  const rewindDisabledReason =
    rewindUnavailableReason(snapshot, submitting) ||
    (queuePending ? t('rewind.queueUpdating') : undefined) ||
    (approvalPending ? t('rewind.approvalSubmitting') : undefined) ||
    (props.forkingMessageId ? t('rewind.forkCreating') : undefined);
  const rewindStaleReason =
    rewind &&
    (snapshot.messages.at(-1)?.id !== rewind.expectedHeadId ||
      !snapshot.messages.some(
        (message) => message.id === rewind.message.id && hasMessageForkAnchor(message),
      ))
      ? t('rewind.historyChanged')
      : undefined;
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<
    'draft.tooLong' | 'draft.quoteLimit' | 'draft.quoteTooLong' | 'draft.selectionTooLong'
  >();
  const [focusRequest, setFocusRequest] = useState(0);
  const draftDisabled = snapshot.session.status === 'archived' || submitting;

  useEffect(() => {
    if (!draft.text) setEditing(false);
  }, [draft.text]);

  useLayoutEffect(() => {
    if (!focusRequest) return;
    const input = inputRef.current;
    input?.focus();
    const length = input?.value.length ?? 0;
    input?.setSelectionRange(length, length);
  }, [focusRequest]);

  const focusInput = useCallback(() => {
    setFocusRequest((previous) => previous + 1);
  }, []);

  const replaceText = useCallback(
    (text: string) => {
      if (draftDisabled) return false;
      if (text.length > composerTextLimit) {
        setActionError('draft.tooLong');
        return false;
      }
      onDraftChange((previous) => ({ ...previous, text }));
      setActionError(undefined);
      setEditing(true);
      return true;
    },
    [draftDisabled, onDraftChange],
  );

  const editMessage = useCallback(
    (message: Message, trigger: HTMLButtonElement) => {
      if (draftDisabled || message.sessionId !== sessionId) return;
      setActionError(undefined);
      if (getDraft().text.length) {
        setReplacement({ sessionId, text: message.text, trigger });
      } else if (replaceText(message.text)) focusInput();
    },
    [draftDisabled, sessionId, getDraft, replaceText, focusInput],
  );

  const quoteMessage = useCallback(
    (message: Message, excerpt?: string): boolean => {
      if (draftDisabled || message.sessionId !== sessionId || message.role !== 'assistant')
        return false;
      const draft = getDraft();
      const existing = draft.messageQuotes ?? [];
      const duplicate = existing.some((item) =>
        excerpt === undefined
          ? item.id === message.id
          : item.sourceMessageId === message.id && item.text === excerpt,
      );
      if (duplicate) {
        setActionError(undefined);
        focusInput();
        return true;
      }
      if (existing.length >= messageQuoteLimit) {
        setActionError('draft.quoteLimit');
        return false;
      }
      const quote =
        excerpt === undefined
          ? { id: message.id, text: message.text }
          : { id: `quote:${crypto.randomUUID()}`, sourceMessageId: message.id, text: excerpt };
      const messageQuotes = [...existing, quote];
      if (formatMessageText(draft.text, messageQuotes).length > composerTextLimit) {
        setActionError(excerpt === undefined ? 'draft.quoteTooLong' : 'draft.selectionTooLong');
        return false;
      }
      onDraftChange((previous) => ({ ...previous, messageQuotes }));
      setActionError(undefined);
      focusInput();
      return true;
    },
    [draftDisabled, sessionId, getDraft, onDraftChange, focusInput],
  );

  const quoteReply = useCallback((message: Message) => quoteMessage(message), [quoteMessage]);
  const quoteSelection = useCallback(
    (id: string, text: string) => {
      const message = snapshot.messages.find((item) => item.id === id);
      return message ? quoteMessage(message, text) : false;
    },
    [snapshot.messages, quoteMessage],
  );

  const chooseRewind = useCallback(
    (message: Message, trigger: HTMLButtonElement) => {
      if (rewind || rewindDisabledReason || !onRewindMessage) return;
      const index = snapshot.messages.findIndex((item) => item.id === message.id);
      const head = snapshot.messages.at(-1);
      if (
        message.sessionId !== sessionId ||
        !hasMessageForkAnchor(message) ||
        index < 0 ||
        index === snapshot.messages.length - 1 ||
        !head
      )
        return;
      setRewind({
        message,
        trigger,
        expectedHeadId: head.id,
        subsequentMessageCount: snapshot.messages.length - index - 1,
      });
    },
    [rewind, rewindDisabledReason, onRewindMessage, snapshot.messages, sessionId],
  );

  async function confirmRewind() {
    if (!rewind || !props.onRewindMessage) throw new Error(t('rewind.unavailable'));
    const reason = rewindStaleReason || rewindDisabledReason;
    if (reason) throw new Error(reason);
    await props.onRewindMessage(rewind.message.id, rewind.expectedHeadId);
  }

  return (
    <>
      <Conversation
        key={`conversation:${snapshot.session.id}`}
        snapshot={snapshot}
        composerPlanRunId={composerPlan?.id}
        onRetry={onRetry}
        onTrace={onTrace}
        onOpenLink={onOpenLink}
        onEditMessage={editMessage}
        onQuoteMessage={quoteReply}
        onQuoteSelection={quoteSelection}
        onForkMessage={props.onForkMessage}
        onRewindMessage={props.onRewindMessage ? chooseRewind : undefined}
        rewindDisabledReason={rewindDisabledReason}
        forkingMessageId={props.forkingMessageId}
        submitting={submitting}
      />
      {snapshot.messageQueue ? (
        <MessageQueue
          key={`queue:${snapshot.session.id}`}
          sessionId={snapshot.session.id}
          queue={snapshot.messageQueue}
          activeRun={snapshot.runs.find((run) =>
            ['running', 'awaiting_permission', 'stopping'].includes(run.status),
          )}
          archived={snapshot.session.status === 'archived'}
          available={
            snapshot.workspace ? snapshot.workspace.state === 'ready' : snapshot.project.available
          }
        />
      ) : null}
      <Composer
        key={`composer:${snapshot.session.id}`}
        snapshot={snapshot}
        draft={draft}
        taskPlanRun={composerPlan}
        inputRef={inputRef}
        editingMessage={editing}
        draftActionError={actionError ? t(actionError, { count: messageQuoteLimit }) : ''}
        onRemoveQuote={(id) => {
          if (draftDisabled) return;
          onDraftChange((previous) => ({
            ...previous,
            messageQuotes: previous.messageQuotes?.filter((item) => item.id !== id),
          }));
          setActionError(undefined);
          focusInput();
        }}
        defaultModel={props.defaultModel}
        nativeExecution={props.nativeExecution}
        onModelChange={props.onModelChange}
        onEffortChange={props.onEffortChange}
        onModeChange={props.onModeChange}
        onDraftChange={props.onDraftChange}
        onSend={props.onSend}
        onStop={props.onStop}
        submitting={submitting}
      />
      {rewind ? (
        <RewindMessageDialog
          message={rewind.message}
          subsequentMessageCount={rewind.subsequentMessageCount}
          projectPath={snapshot.project.path}
          trigger={rewind.trigger}
          disabledReason={rewindStaleReason || rewindDisabledReason}
          onConfirm={confirmRewind}
          onClose={() => setRewind(undefined)}
          onConfirmedFocus={focusInput}
        />
      ) : null}
      {replacement ? (
        <ReplaceDraftDialog
          trigger={replacement.trigger}
          disabled={draftDisabled}
          onConfirm={() =>
            replacement.sessionId === snapshot.session.id && replaceText(replacement.text)
          }
          onClose={() => setReplacement(undefined)}
          onConfirmedFocus={focusInput}
        />
      ) : null}
    </>
  );
}
