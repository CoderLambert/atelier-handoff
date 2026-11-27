/**
 * @file 有序对话与旧历史共用的气泡、消息页脚、审批及运行结果。
 * @implementation 保留两类消息的操作显示条件与时间格式，复用运行结果和交付物的 DOM。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { useMemo } from 'react';
import { Activity, File, Folder, RotateCcw, Shield } from 'lucide-react';
import type { Message, Permission, Run, ToolCall } from '@shared/types';
import { useUiTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { ArtifactAction } from '@/features/inspector';
import { permissionOperation, StatusBadge } from '@/features/inspector/shared';
import { AttachmentPreview } from './attachment-preview';
import {
  isActive,
  recoverable,
  type RunSlice,
  type TurnActions,
  type TurnState,
} from './conversation-turns';
import { hasMessageForkAnchor, MessageActions } from './message-actions';
import { RunLiveStatus } from './run-live-status';
import { RunSummary } from './run-progress';
import { toolLabel } from './run-stage';
import { TaskPlan } from './task-plan';

export function formatMessageTime(value: string, timeFormat: Intl.DateTimeFormat) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timeFormat.format(parsed);
}

function BrowserToolNotice({
  tools,
  onTrace,
}: {
  tools: readonly ToolCall[];
  onTrace: () => void;
}) {
  const { t } = useUiTranslation('chat');
  const browserTools = tools.filter((tool) => tool.name.startsWith('mcp__atelier__browser_'));
  const last = browserTools.findLast((tool) => tool.status === 'failed');
  if (!last) return null;
  const continued = browserTools.some(
    (tool) => tool.status === 'succeeded' && last.endedAt && tool.startedAt >= last.endedAt,
  );
  return (
    <section
      className="run-recovery"
      data-status="failed"
      aria-label={t('conversation.browserIssue')}
    >
      <div role="status">
        <strong>{t('conversation.toolFailed', { name: toolLabel(last.name, t) })}</strong>
        <p className="break-words">{last.output.slice(0, 550) || t('conversation.traceHelp')}</p>
        {continued ? <p>{t('conversation.browserContinued')}</p> : null}
      </div>
      <div className="run-recovery-actions">
        <Button type="button" variant="outline" size="sm" onClick={onTrace}>
          <Activity data-icon="inline-start" aria-hidden="true" />
          {t('conversation.browserTrace')}
        </Button>
      </div>
    </section>
  );
}

function RunResult({
  run,
  hasText,
  retryDisabled,
  onRetry,
  onTrace,
}: {
  run: Run;
  hasText: boolean;
  retryDisabled: boolean;
  onRetry: (id: string) => void;
  onTrace: (id: string) => void;
}) {
  const { t } = useUiTranslation('chat');
  if (isActive(run)) return null;
  const canRetry = recoverable(run);
  const detail =
    run.status === 'stopped' ? t('conversation.stoppedReason') : run.error || run.reason;
  if (!canRetry && !run.error && !run.reason) return null;
  const title = canRetry
    ? hasText
      ? t('conversation.partialReply')
      : t('conversation.incompleteReply')
    : t('conversation.executionResult');
  return (
    <section
      className="run-recovery"
      data-status={run.status}
      aria-label={t('conversation.runResult')}
    >
      <div className="run-recovery-heading">
        <strong>{title}</strong>
        <div className="run-recovery-actions">
          <Button type="button" variant="outline" size="sm" onClick={() => onTrace(run.id)}>
            <Activity data-icon="inline-start" aria-hidden="true" />
            {t('conversation.viewTrace')}
          </Button>
          {canRetry ? (
            <Button
              type="button"
              size="sm"
              disabled={retryDisabled}
              onClick={() => onRetry(run.id)}
            >
              <RotateCcw data-icon="inline-start" aria-hidden="true" />
              {t('conversation.resumeReadOnly')}
            </Button>
          ) : null}
        </div>
      </div>
      {detail ? <p>{detail}</p> : null}
      {canRetry ? <p>{t('conversation.retryHelp')}</p> : null}
    </section>
  );
}

function FormattedUserMessage({ text }: { text: string }) {
  const parts = useMemo(() => {
    const regex = /(?:^|(?<=[\s(\["']))@([a-zA-Z0-9_\-./]+)(?=[,.;:!?)\]"'\s]|$)/g;
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0];
      const rawPath = match[1];
      if (!rawPath) continue;

      if (match.index > lastIndex) {
        nodes.push(text.slice(lastIndex, match.index));
      }

      const isDir = rawPath.endsWith('/');
      const cleanPath = isDir ? rawPath.slice(0, -1) : rawPath;
      const lastSlash = cleanPath.lastIndexOf('/');
      const dir = lastSlash >= 0 ? cleanPath.slice(0, lastSlash + 1) : '';
      const name =
        (lastSlash >= 0 ? cleanPath.slice(lastSlash + 1) : cleanPath) + (isDir ? '/' : '');

      nodes.push(
        <span key={match.index} className="composer-file-mention-badge" title={rawPath}>
          {isDir ? (
            <Folder className="file-mention-icon" aria-hidden="true" />
          ) : (
            <File className="file-mention-icon" aria-hidden="true" />
          )}
          <span className="file-mention-at">@</span>
          {dir ? <span className="file-mention-dir">{dir}</span> : null}
          <strong className="file-mention-name">{name}</strong>
        </span>,
      );

      lastIndex = match.index + fullMatch.length;
    }

    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex));
    }

    return nodes.length ? nodes : [text];
  }, [text]);

  return <>{parts}</>;
}

function MessageContext({ run, attachments }: { run: Run; attachments: RunSlice['attachments'] }) {
  const { t } = useUiTranslation('chat');
  const references = [
    ...run.contextPaths.map((path) => ({
      key: `file:${path}`,
      label: t('conversation.readProjectFile', { path }),
    })),
    ...(run.extensions || []).map((extension) => ({
      key: `extension:${extension.id}`,
      label: t('conversation.extension', {
        kind: extension.kind === 'mcp' ? 'MCP' : extension.kind === 'skill' ? 'Skill' : 'Command',
        name: extension.name,
      }),
    })),
  ];
  return references.length || run.attachmentIds.length ? (
    <ul className="message-context" aria-label={t('conversation.context')}>
      {run.attachmentIds.map((id, index) => {
        const item = attachments[index];
        return item && !item.removed ? (
          <li key={`attachment:${id}`} className="message-attachment">
            <AttachmentPreview attachment={item}>
              {t('conversation.attachment', { name: item.name })}
            </AttachmentPreview>
          </li>
        ) : (
          <li key={`attachment:${id}`}>
            {t('conversation.attachmentUnavailable', { name: item?.name ?? id })}
          </li>
        );
      })}
      {references.map((reference) => (
        <li key={reference.key}>{reference.label}</li>
      ))}
    </ul>
  ) : null;
}

export function ChatApproval({
  permission,
  onPermission,
}: {
  permission: Permission;
  onPermission: TurnActions['onPermission'];
}) {
  const { t } = useUiTranslation('chat');
  const pending = permission.status === 'pending';
  return (
    <section className="chat-approval" data-pending={pending}>
      <div className="chat-approval-copy">
        <div className="chat-approval-title" role="status">
          <strong>
            <Shield data-icon="inline-start" aria-hidden="true" />
            {pending ? t('conversation.approvalRequired') : permissionOperation(permission)}
          </strong>
          {pending ? (
            <span>{permissionOperation(permission)}</span>
          ) : (
            <StatusBadge status={permission.status} />
          )}
        </div>
        {permission.path || permission.command ? (
          <p className="chat-approval-target">{permission.path || permission.command}</p>
        ) : null}
        {pending && permission.reason ? (
          <p className="chat-approval-reason">{permission.reason}</p>
        ) : null}
      </div>
      <Button
        type="button"
        size="sm"
        variant={pending ? 'default' : 'outline'}
        onClick={() => onPermission(permission)}
      >
        {pending ? t('conversation.reviewApproval') : t('conversation.approvalHistory')}
      </Button>
    </section>
  );
}

export function UserMessageBubble({
  text,
  run,
  attachments,
  contextRestarted,
}: Pick<RunSlice, 'run' | 'attachments' | 'contextRestarted'> & { text: string }) {
  const { t } = useUiTranslation('chat');
  return (
    <div className="user-message-bubble">
      <div className="message-text">
        <FormattedUserMessage text={text} />
      </div>
      {run ? <MessageContext run={run} attachments={attachments} /> : null}
      {contextRestarted ? (
        <p className="message-placeholder">{t('conversation.branchRestored')}</p>
      ) : null}
    </div>
  );
}

type FooterState = Pick<
  TurnState,
  | 'sessionId'
  | 'submitting'
  | 'archived'
  | 'forkingMessageId'
  | 'rewindDisabledReason'
  | 'actions'
  | 'messageTime'
>;

export function MessageFooter({
  message,
  at,
  hasSubsequent,
  legacyHasText,
  state,
}: {
  message: Message;
  at: string;
  hasSubsequent: boolean;
  legacyHasText?: boolean;
  state: FooterState;
}) {
  const {
    actions,
    submitting,
    archived,
    forkingMessageId,
    rewindDisabledReason,
    sessionId,
    messageTime,
  } = state;
  const showActions =
    legacyHasText !== false ||
    (hasMessageForkAnchor(message) && (actions.onForkMessage || actions.onRewindMessage));
  return (
    <footer className="message-footer">
      <time dateTime={at} title={formatMessageTime(at, messageTime.full)}>
        {formatMessageTime(at, messageTime.short)}
      </time>
      {showActions ? (
        <MessageActions
          key={legacyHasText === undefined ? undefined : `${sessionId}:${message.id}`}
          message={message}
          disabled={submitting || archived}
          onEdit={actions.onEditMessage}
          onQuote={actions.onQuoteMessage}
          onFork={actions.onForkMessage}
          onRewind={actions.onRewindMessage}
          subsequentMessageCount={hasSubsequent ? 1 : 0}
          rewindDisabledReason={rewindDisabledReason}
          forking={forkingMessageId === message.id}
          forkDisabled={submitting || Boolean(forkingMessageId)}
        />
      ) : null}
    </footer>
  );
}

type EndState = Pick<TurnState, 'retryDisabled' | 'actions'>;
type EndSlice = RunSlice & { run: Run };

export function RunEndExtras({
  slice: { run, tools, artifacts },
  state: { retryDisabled, actions },
  hasText,
  showSummary,
}: {
  slice: EndSlice;
  state: EndState;
  hasText: boolean;
  showSummary?: boolean;
}) {
  const { t } = useUiTranslation('chat');
  const active = isActive(run);
  const onTrace = () => actions.onTrace(run.id);
  return (
    <>
      <BrowserToolNotice tools={tools} onTrace={onTrace} />
      {showSummary && !active ? <RunSummary run={run} tools={tools} onTrace={onTrace} /> : null}
      <RunResult
        run={run}
        hasText={hasText}
        retryDisabled={retryDisabled}
        onRetry={actions.onRetry}
        onTrace={actions.onTrace}
      />
      {!active && artifacts.length ? (
        <section className="chat-deliverables" aria-label={t('conversation.deliverables')}>
          <h3 className="sr-only">{t('conversation.deliverables')}</h3>
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <ArtifactAction artifact={artifact} showDownload variant="compact" />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function RunEndSummary({ slice, state }: { slice: EndSlice; state: TurnState }) {
  const { run, tools, events, subagents, hasAssistantText } = slice;
  const active = isActive(run);
  return (
    <div
      className="transcript-run-end"
      data-transcript-kind={!active ? 'summary' : undefined}
      data-run-id={run.id}
    >
      {!state.isComposerPlanOwner && run.plan.length > 0 ? (
        <TaskPlan steps={run.plan} embedded={!active} />
      ) : null}
      <RunEndExtras slice={slice} state={state} hasText={hasAssistantText} showSummary />
      {active ? (
        <RunLiveStatus
          run={run}
          tools={tools}
          events={events}
          subagents={subagents}
          stopPending={state.stopPending}
        />
      ) : null}
    </div>
  );
}
