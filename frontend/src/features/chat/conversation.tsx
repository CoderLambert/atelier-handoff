/**
 * @file 组合会话对话、历史轮次和审批与输出弹窗。
 * @implementation 将运行切片分派给两类记忆化轮次，由独立 hook 管理滚动并为轮次提供稳定的消息操作。
 * @updated 2026-11-27T19:30:00+08:00
 */
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import type { Permission, ToolCall } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { RunInspectorDialogs } from '@/features/inspector';
import { useUiTranslation } from '@/i18n';
import { ChatWebLinkDialog, type ChatLinkOpener } from './chat-web-link-dialog';
import { formatMessageTime } from './conversation-turn-parts';
import {
  buildConversationTurns,
  isActive,
  recoverable,
  type TurnActions,
  type TurnState,
} from './conversation-turns';
import { LegacyMessageTurn } from './legacy-message-turn';
import { Markdown } from './markdown';
import type { MessageDraftAction } from './message-actions';
import { OrderedRun } from './ordered-run';
import { SelectionQuote, type QuoteSelectionAction } from './selection-quote';
import { useAutoFollowScroll } from './use-auto-follow-scroll';

interface ConversationProps {
  snapshot: Snapshot;
  composerPlanRunId?: string;
  stopPendingRunId?: string;
  onRetry: (id: string) => void;
  onTrace: (id: string) => void;
  onOpenSchedule?: (taskId: string) => void;
  onOpenLink?: ChatLinkOpener;
  onEditMessage?: MessageDraftAction;
  onQuoteMessage?: MessageDraftAction;
  onQuoteSelection?: QuoteSelectionAction;
  onForkMessage?: (messageId: string) => void;
  onRewindMessage?: MessageDraftAction;
  rewindDisabledReason?: string;
  forkingMessageId?: string;
  submitting: boolean;
}

function useTurnActions(
  props: ConversationProps,
  onPermission: TurnActions['onPermission'],
  onOutput: TurnActions['onOutput'],
  chooseWebLink: NonNullable<TurnActions['onLinkClick']>,
): TurnActions {
  // Parent handlers can close over the latest snapshot, especially the rewind head check.
  // Read the committed handlers at click time while exposing their availability as props.
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  }, [props]);
  const canEdit = Boolean(props.onEditMessage);
  const canQuote = Boolean(props.onQuoteMessage);
  const canFork = Boolean(props.onForkMessage);
  const canRewind = Boolean(props.onRewindMessage);
  const canOpenLink = Boolean(props.onOpenLink);
  return useMemo<TurnActions>(
    () => ({
      onRetry: (id) => current.current.onRetry(id),
      onTrace: (id) => current.current.onTrace(id),
      onOpenSchedule: (taskId) => current.current.onOpenSchedule?.(taskId),
      onEditMessage: canEdit ? (...args) => current.current.onEditMessage?.(...args) : undefined,
      onQuoteMessage: canQuote ? (...args) => current.current.onQuoteMessage?.(...args) : undefined,
      onForkMessage: canFork ? (id) => current.current.onForkMessage?.(id) : undefined,
      onRewindMessage: canRewind
        ? (...args) => current.current.onRewindMessage?.(...args)
        : undefined,
      onLinkClick: canOpenLink ? chooseWebLink : undefined,
      onPermission,
      onOutput,
    }),
    [canEdit, canQuote, canFork, canRewind, canOpenLink, chooseWebLink, onPermission, onOutput],
  );
}

export const Conversation = memo(function Conversation(props: ConversationProps) {
  const {
    snapshot,
    composerPlanRunId,
    stopPendingRunId,
    onOpenLink,
    onQuoteSelection,
    rewindDisabledReason,
    forkingMessageId,
    submitting,
  } = props;
  const { t, locale } = useUiTranslation('chat');
  const messageTime = useMemo(
    () => ({
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }),
      short: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }),
    }),
    [locale],
  );
  const { viewport, thread, unseen, scrollToBottom, handleScroll, handleClickCapture } =
    useAutoFollowScroll(snapshot);
  const [permissionId, setPermissionId] = useState<string>();
  const [outputToolId, setOutputToolId] = useState<string>();
  const [webLink, setWebLink] = useState<{ url: string; trigger: HTMLAnchorElement }>();
  const onPermission = useCallback((permission: Permission) => setPermissionId(permission.id), []);
  const onOutput = useCallback((tool: ToolCall) => setOutputToolId(tool.id), []);
  const chooseWebLink = useCallback((url: string, event: MouseEvent<HTMLAnchorElement>) => {
    setWebLink({ url, trigger: event.currentTarget });
  }, []);
  const actions = useTurnActions(props, onPermission, onOutput, chooseWebLink);
  const {
    session,
    inheritedMessages,
    messages,
    runs,
    tools,
    events,
    artifacts,
    permissions,
    subagents,
    attachments,
  } = snapshot;
  const turns = useMemo(
    () =>
      buildConversationTurns({
        messages,
        runs,
        tools,
        events,
        artifacts,
        permissions,
        subagents,
        attachments,
      }),
    [messages, runs, tools, events, artifacts, permissions, subagents, attachments],
  );
  const outputTool = outputToolId
    ? tools.find((tool) => tool.sessionId === session.id && tool.id === outputToolId)
    : undefined;
  const permission = permissionId
    ? permissions.find((item) => item.id === permissionId)
    : undefined;
  const archived = session.status === 'archived';
  const retryDisabled = submitting || archived || runs.some(isActive);
  const turnState = {
    sessionId: session.id,
    hasFork: Boolean(session.fork),
    submitting,
    archived,
    forkingMessageId,
    rewindDisabledReason,
    actions,
    messageTime,
  };

  return (
    <div
      ref={viewport}
      id="conversation-content"
      className="conversation-content chat-conversation"
      role="region"
      aria-label={t('conversation.label')}
      tabIndex={0}
      onClickCapture={handleClickCapture}
      onScroll={handleScroll}
    >
      <div ref={thread} className="message-thread" data-session-id={session.id}>
        {inheritedMessages?.length ? (
          <section className="inherited-messages" aria-label={t('conversation.inheritedLabel')}>
            <header>
              <h3>{t('conversation.inheritedTitle')}</h3>
              <p>
                {t('conversation.inheritedDescription', {
                  title: session.fork?.sourceTitle ?? t('conversation.sourceSession'),
                })}
              </p>
            </header>
            {inheritedMessages.map((message) => (
              <article key={message.id} className="inherited-message">
                <div className="message-meta">
                  <strong>
                    {message.role === 'assistant' ? 'atelier' : t('conversation.you')}
                  </strong>
                  <time dateTime={message.createdAt}>
                    {formatMessageTime(message.createdAt, messageTime.full)}
                  </time>
                </div>
                {message.role === 'assistant' ? (
                  <Markdown text={message.text} onLinkClick={actions.onLinkClick} />
                ) : (
                  <div className="message-text">{message.text}</div>
                )}
              </article>
            ))}
          </section>
        ) : null}
        {turns.length ? (
          turns.map((turn) => {
            const { run } = turn.slice;
            const ownsRunStatus = turn.kind === 'ordered' || turn.isFooterOwner;
            const state: TurnState = {
              ...turnState,
              isComposerPlanOwner: ownsRunStatus && Boolean(run && run.id === composerPlanRunId),
              stopPending: ownsRunStatus && Boolean(run && run.id === stopPendingRunId),
              retryDisabled: retryDisabled && ownsRunStatus && Boolean(run && recoverable(run)),
            };
            return turn.kind === 'ordered' ? (
              <OrderedRun key={`ordered:${turn.slice.run.id}`} turn={turn} {...state} />
            ) : (
              <LegacyMessageTurn key={turn.message.id} turn={turn} {...state} />
            );
          })
        ) : !inheritedMessages?.length ? (
          <div className="welcome">
            <div className="welcome-badge" aria-hidden="true">
              <Sparkles />
            </div>
            <h2>{t('conversation.welcomeTitle')}</h2>
            <p>{t('conversation.welcomeHelp')}</p>
          </div>
        ) : null}
      </div>
      {onQuoteSelection && !submitting && !archived && !webLink && !outputTool && !permission ? (
        <SelectionQuote viewport={viewport} onQuote={onQuoteSelection} />
      ) : null}
      {unseen ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="new-messages"
          onClick={scrollToBottom}
        >
          <ArrowDown data-icon="inline-start" aria-hidden="true" />
          {permissions.some((item) => item.status === 'pending')
            ? t('conversation.pendingApproval')
            : t('conversation.newMessages')}
        </Button>
      ) : null}
      {webLink && onOpenLink ? (
        <ChatWebLinkDialog
          key={webLink.url}
          url={webLink.url}
          trigger={webLink.trigger}
          onOpenLink={onOpenLink}
          onClose={() => setWebLink(undefined)}
        />
      ) : null}
      <RunInspectorDialogs
        source={snapshot}
        outputTool={outputTool}
        permission={permission}
        outputFallback={<p role="status">{t('conversation.openingOutput')}</p>}
        approvalFallback={<p role="status">{t('conversation.openingApproval')}</p>}
        onCloseOutput={() => setOutputToolId(undefined)}
        onCloseApproval={() => setPermissionId(undefined)}
        outputFirst
      />
    </div>
  );
});
