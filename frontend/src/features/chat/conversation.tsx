/**
 * @file 展示会话消息、运行进度与历史、浏览器异常及网页链接选择入口。
 * @implementation 按运行组织消息，以状态和耗时汇总结束的运行。通过统一入口展开工具、任务清单和子任务，并提供审批、输出及历史操作入口。
 * @updated 2026-11-25T18:35:00+08:00
 */
import { useUiTranslation, getTranslator } from '@/i18n';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import type {
  Artifact,
  Attachment,
  Message,
  Permission,
  Run,
  RunEvent,
  ToolCall,
} from '@shared/types';
import { Activity, ArrowDown, ChevronRight, File, Folder, RotateCcw, Shield } from 'lucide-react';
import { activeStatuses } from '@shared/types';
import { cn } from '@/components/ui/utils';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  ArtifactAction,
  SubagentProgress,
  groupRunWork,
  permissionSubagentSource,
} from '@/features/inspector';
import { permissionOperation, StatusBadge, statusLabel } from '@/features/inspector/shared';
import { formatDuration } from '@/utils/format';
import { AttachmentPreview } from './attachment-preview';
import { ChatWebLinkDialog, type ChatLinkOpener } from './chat-web-link-dialog';
import { Markdown } from './markdown';
import { hasMessageForkAnchor, MessageActions, type MessageDraftAction } from './message-actions';
import { RunToolActivity } from './run-tool-activity';
import { SelectionQuote, type QuoteSelectionAction } from './selection-quote';
import { TaskPlan } from './task-plan';
const ToolOutputDialog = lazy(() => import('@/features/inspector/tool-output-dialog'));

const PermissionDialog = lazy(() => import('@/features/inspector/permission-dialog'));

export const isActive = (run: Run) => activeStatuses.includes(run.status);
const recoverable = (run: Run) => ['failed', 'stopped', 'interrupted'].includes(run.status);
const toolLabels: Readonly<
  Record<
    string,
    | 'tool.read'
    | 'tool.skill'
    | 'tool.list'
    | 'tool.search'
    | 'tool.edit'
    | 'tool.write'
    | 'tool.delete'
    | 'tool.command'
    | 'tool.weather'
    | 'tool.plan'
    | 'tool.publish'
    | 'tool.navigate'
    | 'tool.snapshot'
    | 'tool.screenshot'
    | 'tool.click'
    | 'tool.type'
  >
> = {
  Read: 'tool.read',
  Skill: 'tool.skill',
  list_files: 'tool.list',
  search_files: 'tool.search',
  edit_file: 'tool.edit',
  write_file: 'tool.write',
  delete_file: 'tool.delete',
  run_command: 'tool.command',
  weather_lookup: 'tool.weather',
  update_plan: 'tool.plan',
  publish_artifact: 'tool.publish',
  browser_navigate: 'tool.navigate',
  browser_snapshot: 'tool.snapshot',
  browser_take_screenshot: 'tool.screenshot',
  browser_click: 'tool.click',
  browser_type: 'tool.type',
};
const toolStatuses = {
  running: 'tool.running',
  awaiting_permission: 'tool.awaitingPermission',
  succeeded: 'tool.succeeded',
  failed: 'tool.failed',
  denied: 'tool.denied',
  canceled: 'tool.canceled',
} as const satisfies Record<ToolCall['status'], string>;
const modelEvents = new Set([
  'sdk.initialized',
  'sdk.api_retry',
  'tool.started',
  'tool.finished',
  'subagent.started',
  'subagent.finished',
  'message.delta',
]);
const EMPTY_TOOLS: ToolCall[] = [];
const EMPTY_EVENTS: RunEvent[] = [];
const EMPTY_ARTIFACTS: Artifact[] = [];

function toolLabel(name: string) {
  const short = name.replace(/^mcp__atelier__/, '');
  const key = toolLabels[short];
  return key ? getTranslator('chat')(key) : short;
}
function date(value: string, timeFormat: Intl.DateTimeFormat) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timeFormat.format(parsed);
}
function groupByRun<T extends { runId: string }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.runId);
    if (group) group.push(item);
    else groups.set(item.runId, [item]);
  }
  return groups;
}

function ProgressClock({ at }: { at: string }) {
  const { t } = useUiTranslation('chat');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const milliseconds = now - Date.parse(at);
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return (
    <span>
      {seconds < 60
        ? t('progress.secondsAgo', { count: seconds })
        : t('progress.minutesAgo', { count: Math.floor(seconds / 60), seconds: seconds % 60 })}
    </span>
  );
}

function ModelLoadingIndicator({ label }: { label: string }) {
  return (
    <div className="model-loading-indicator" role="status" aria-live="polite" aria-label={label}>
      <span className="model-loading-dot" />
      <span className="model-loading-dot" />
      <span className="model-loading-dot" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function RunProgress({
  run,
  tools,
  events,
  hasText,
  snapshot,
  showPlan,
  onPermission,
  onOutput,
  onTrace,
}: {
  run: Run;
  tools: ToolCall[];
  events: RunEvent[];
  hasText: boolean;
  snapshot: Snapshot;
  showPlan: boolean;
  onPermission: (permission: Permission) => void;
  onOutput: (tool: ToolCall) => void;
  onTrace: () => void;
}) {
  const { t, locale } = useUiTranslation('chat');
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const work = useMemo(
    () => groupRunWork(snapshot, run),
    [snapshot.session.id, snapshot.subagents, snapshot.tools, snapshot.permissions, run],
  );
  const active = isActive(run);
  const runningSubagents = work.subagents.filter(({ subagent }) => subagent?.status === 'running');
  const ongoing = tools.find((tool) => tool.status === 'running');
  const finished = tools.filter((tool) => tool.endedAt);
  const last = finished.reduce<ToolCall | undefined>(
    (latest, tool) => (!latest || tool.endedAt! >= latest.endedAt! ? tool : latest),
    undefined,
  );
  const activity = events.findLast((event) => modelEvents.has(event.type));
  let stage: string = t('progress.waitingModel');
  if (run.status === 'queued') stage = t('progress.queued');
  else if (run.status === 'awaiting_permission') stage = t('progress.awaitingApproval');
  else if (run.status === 'stopping') stage = t('progress.stopping');
  else if (ongoing) stage = t('progress.callingTool', { name: toolLabel(ongoing.name) });
  else if (runningSubagents.length)
    stage = t('progress.runningSubtasks', { count: runningSubagents.length });
  else if (activity?.type === 'sdk.api_retry') stage = t('progress.retryingModel');
  else if (activity?.type === 'message.delta' && hasText) stage = t('progress.receiving');
  else if (!activity && !tools.length && !hasText) stage = t('progress.starting');
  const approved = useMemo(
    () =>
      new Set(
        work.permissions.filter((p) => p.decisionSource === 'automatic').map((p) => p.toolCallId),
      ),
    [work],
  );
  const hasDetails = work.tools.length > 0 || work.subagents.length > 0 || showPlan;
  const isPureModelWaiting =
    !hasDetails && run.status !== 'awaiting_permission' && run.status !== 'stopping';
  if (active && isPureModelWaiting) {
    if (hasText) return null;
    return <ModelLoadingIndicator label={t('progress.waitingModel')} />;
  }
  const duration =
    run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : NaN;
  const status = active ? '' : statusLabel(run.status);
  const summary =
    !active && Number.isFinite(duration) && duration >= 0
      ? t('progress.historyDuration', { status, duration: formatDuration(duration, locale) })
      : status;
  return (
    <section
      className="run-progress"
      data-status={run.status}
      data-active={active}
      aria-label={active ? t('progress.label') : t('progress.history')}
    >
      {!active &&
        (hasDetails ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="run-history-toggle"
            aria-expanded={historyOpen}
            aria-controls={historyId}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            {summary}
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        ) : (
          <p className="run-history-status">{summary}</p>
        ))}
      {active ? (
        <div className="run-progress-head">
          {stage === t('progress.waitingModel') ? (
            <div
              className="run-progress-loading-inline"
              role="status"
              aria-live="polite"
              aria-label={t('progress.waitingModel')}
            >
              <span className="model-loading-dot" />
              <span className="model-loading-dot" />
              <span className="model-loading-dot" />
              <span className="sr-only">{t('progress.waitingModel')}</span>
            </div>
          ) : (
            <strong role="status">{stage}</strong>
          )}
          <ProgressClock
            at={events.at(-1)?.at || last?.endedAt || run.startedAt || run.createdAt}
          />
        </div>
      ) : null}
      {active && tools.length > 0 ? (
        <p className="run-progress-tools">
          {t('progress.toolsFinished', {
            finished: finished.length,
            count: tools.length,
            recent: last
              ? t('progress.recentTool', {
                  name: toolLabel(last.name),
                  status: t(toolStatuses[last.status]),
                })
              : '',
          })}
        </p>
      ) : null}
      {hasDetails ? (
        <div
          className="run-progress-content"
          id={historyId}
          hidden={!active && !historyOpen}
          onFocusCapture={() => {
            if (active) setHistoryOpen(true);
          }}
        >
          {work.tools.length ? (
            <RunToolActivity
              tools={work.tools}
              active={active}
              historyOpen={historyOpen}
              approved={approved}
              onOutput={onOutput}
            />
          ) : null}
          {showPlan && (active || historyOpen) ? (
            <TaskPlan steps={run.plan} embedded={!active} />
          ) : null}
          <SubagentProgress
            groups={work.subagents}
            run={run}
            onPermission={onPermission}
            onToolOutput={onOutput}
            onTrace={onTrace}
          />
        </div>
      ) : null}
    </section>
  );
}

function BrowserToolNotice({ tools, onTrace }: { tools: ToolCall[]; onTrace: () => void }) {
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
        <strong>{t('conversation.toolFailed', { name: toolLabel(last.name) })}</strong>
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
  tools,
  hasArtifacts,
  hasText,
  retryDisabled,
  onRetry,
  onTrace,
}: {
  run: Run;
  tools: ToolCall[];
  hasArtifacts: boolean;
  hasText: boolean;
  retryDisabled: boolean;
  onRetry: (id: string) => void;
  onTrace: (id: string) => void;
}) {
  const { t } = useUiTranslation('chat');
  if (isActive(run)) return null;
  const canRetry = recoverable(run);
  if (!canRetry && !hasArtifacts && (hasText || !tools.length)) return null;
  const title = canRetry
    ? hasText
      ? t('conversation.partialReply')
      : t('conversation.incompleteReply')
    : t('conversation.executionResult');
  const completedTools = tools.filter((tool) => tool.status === 'succeeded').length;
  return (
    <section
      className="run-recovery"
      data-status={run.status}
      aria-label={t('conversation.runResult')}
    >
      <strong>{title}</strong>
      {run.error || run.reason ? <p>{run.error || run.reason}</p> : null}
      {tools.length > 0 ? (
        <div className="run-recovery-progress-group">
          <p>
            {t('conversation.toolsCompleted', {
              completed: completedTools,
              count: tools.length,
            })}
          </p>
          <div className="run-recovery-progress" aria-hidden="true">
            <span style={{ width: `${(completedTools / tools.length) * 100}%` }} />
          </div>
        </div>
      ) : null}
      <div className="run-recovery-actions">
        <Button type="button" variant="outline" size="sm" onClick={() => onTrace(run.id)}>
          <Activity data-icon="inline-start" aria-hidden="true" />
          {t('conversation.viewTrace')}
        </Button>
        {canRetry ? (
          <Button type="button" size="sm" disabled={retryDisabled} onClick={() => onRetry(run.id)}>
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            {t('conversation.checkProgress')}
          </Button>
        ) : null}
      </div>
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

function MessageContext({ run, attachments }: { run: Run; attachments: Map<string, Attachment> }) {
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
      {run.attachmentIds.map((id) => {
        const item = attachments.get(id);
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

function ChatApproval({ permission, onOpen }: { permission: Permission; onOpen: () => void }) {
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
      <Button type="button" size="sm" variant={pending ? 'default' : 'outline'} onClick={onOpen}>
        {pending ? t('conversation.reviewApproval') : t('conversation.approvalHistory')}
      </Button>
    </section>
  );
}

export function Conversation({
  snapshot,
  composerPlanRunId,
  onRetry,
  onTrace,
  onOpenLink,
  onEditMessage,
  onQuoteMessage,
  onQuoteSelection,
  onForkMessage,
  onRewindMessage,
  rewindDisabledReason,
  forkingMessageId,
  submitting,
}: {
  snapshot: Snapshot;
  composerPlanRunId?: string;
  onRetry: (id: string) => void;
  onTrace: (id: string) => void;
  onOpenLink?: ChatLinkOpener;
  onEditMessage?: MessageDraftAction;
  onQuoteMessage?: MessageDraftAction;
  onQuoteSelection?: QuoteSelectionAction;
  onForkMessage?: (messageId: string) => void;
  onRewindMessage?: MessageDraftAction;
  rewindDisabledReason?: string;
  forkingMessageId?: string;
  submitting: boolean;
}) {
  const { t, locale } = useUiTranslation('chat');
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }),
    [locale],
  );
  const shortTimeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { timeStyle: 'short' }),
    [locale],
  );
  const viewport = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const [permissionId, setPermissionId] = useState<string>();
  const [outputToolId, setOutputToolId] = useState<string>();
  const outputTool = outputToolId
    ? snapshot.tools.find(
        (tool) => tool.sessionId === snapshot.session.id && tool.id === outputToolId,
      )
    : undefined;
  const [webLink, setWebLink] = useState<{ url: string; trigger: HTMLAnchorElement }>();
  const chooseWebLink = useCallback((url: string, event: MouseEvent<HTMLAnchorElement>) => {
    setWebLink({ url, trigger: event.currentTarget });
  }, []);
  const permission = snapshot.permissions.find((item) => item.id === permissionId);
  const hasPendingApproval = snapshot.permissions.some((item) => item.status === 'pending');
  const indexes = useMemo(
    () => ({
      runs: new Map(snapshot.runs.map((run) => [run.id, run])),
      tools: groupByRun(snapshot.tools),
      events: groupByRun(snapshot.events),
      artifacts: groupByRun(snapshot.artifacts),
      permissions: groupByRun(snapshot.permissions),
      attachments: new Map(snapshot.attachments.map((attachment) => [attachment.id, attachment])),
    }),
    [
      snapshot.runs,
      snapshot.tools,
      snapshot.events,
      snapshot.artifacts,
      snapshot.attachments,
      snapshot.permissions,
    ],
  );
  const messages = useMemo(() => {
    const replies = new Set(
      snapshot.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.runId),
    );
    const missing = new Map(
      snapshot.runs.filter((run) => !replies.has(run.id)).map((run) => [run.id, run]),
    );
    const result: Message[] = [];
    const placeholder = (run: Run): Message => ({
      id: `run-reply:${run.id}`,
      sessionId: run.sessionId,
      runId: run.id,
      role: 'assistant',
      text: '',
      createdAt: run.createdAt,
    });
    for (const message of snapshot.messages) {
      result.push(message);
      const run = missing.get(message.runId);
      if (message.role === 'user' && run) {
        result.push(placeholder(run));
        missing.delete(run.id);
      }
    }
    for (const run of missing.values()) result.push(placeholder(run));
    return result;
  }, [snapshot.messages, snapshot.runs]);
  const subsequentMessageCounts = useMemo(
    () =>
      new Map(
        snapshot.messages.map((message, index) => [
          message.id,
          snapshot.messages.length - index - 1,
        ]),
      ),
    [snapshot.messages],
  );
  const runFooterOwners = useMemo(
    () =>
      new Map(
        messages
          .filter((message) => message.role === 'assistant')
          .map((message) => [message.runId, message.id]),
      ),
    [messages],
  );
  const retryDisabled =
    submitting || snapshot.session.status === 'archived' || snapshot.runs.some(isActive);

  // Keep following only while the reader is near the bottom. Native details state
  // and text selection survive event updates because each message keeps its key.
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    if (nearBottom.current) element.scrollTop = element.scrollHeight;
    else setUnseen(true);
  }, [
    snapshot.messages,
    snapshot.runs,
    snapshot.tools,
    snapshot.subagents,
    snapshot.artifacts,
    snapshot.permissions,
  ]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !thread.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(thread.current);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={viewport}
      id="conversation-content"
      className="conversation-content chat-conversation"
      role="region"
      aria-label={t('conversation.label')}
      tabIndex={0}
      onClickCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            '.run-progress summary, .run-history-toggle, .run-tool-activity button, .chat-task-plan-toggle',
          )
        )
          nearBottom.current = false;
      }}
      onScroll={() => {
        const element = viewport.current;
        if (!element) return;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
        if (nearBottom.current) setUnseen(false);
      }}
    >
      <div ref={thread} className="message-thread" data-session-id={snapshot.session.id}>
        {snapshot.inheritedMessages?.length ? (
          <section className="inherited-messages" aria-label={t('conversation.inheritedLabel')}>
            <header>
              <h3>{t('conversation.inheritedTitle')}</h3>
              <p>
                {t('conversation.inheritedDescription', {
                  title: snapshot.session.fork?.sourceTitle ?? t('conversation.sourceSession'),
                })}
              </p>
            </header>
            {snapshot.inheritedMessages.map((message) => (
              <article key={message.id} className="inherited-message">
                <div className="message-meta">
                  <strong>
                    {message.role === 'assistant' ? 'atelier' : t('conversation.you')}
                  </strong>
                  <time dateTime={message.createdAt}>{date(message.createdAt, timeFormat)}</time>
                </div>
                {message.role === 'assistant' ? (
                  <Markdown
                    text={message.text}
                    onLinkClick={onOpenLink ? chooseWebLink : undefined}
                  />
                ) : (
                  <div className="message-text">{message.text}</div>
                )}
              </article>
            ))}
          </section>
        ) : null}
        {messages.length ? (
          messages.map((message, index) => {
            const assistant = message.role === 'assistant';
            const run = indexes.runs.get(message.runId);
            const tools = indexes.tools.get(message.runId) || EMPTY_TOOLS;
            const events = indexes.events.get(message.runId) || EMPTY_EVENTS;
            const artifacts = indexes.artifacts.get(message.runId) || EMPTY_ARTIFACTS;
            const hasText = Boolean(message.text.trim());
            return (
              <article
                key={message.id}
                className={cn('message', assistant ? 'assistant-message' : 'user-message')}
                aria-label={t(assistant ? 'conversation.assistant' : 'conversation.you')}
                data-message-id={message.id}
                data-run-id={message.runId}
                data-last-message={index === messages.length - 1 || undefined}
              >
                <div className="message-body">
                  {assistant && run && runFooterOwners.get(message.runId) === message.id ? (
                    <RunProgress
                      run={run}
                      tools={tools}
                      events={events}
                      hasText={hasText}
                      snapshot={snapshot}
                      showPlan={run.id !== composerPlanRunId && run.plan.length > 0}
                      onPermission={(item) => setPermissionId(item.id)}
                      onOutput={(tool) => setOutputToolId(tool.id)}
                      onTrace={() => onTrace(run.id)}
                    />
                  ) : null}
                  {assistant && runFooterOwners.get(message.runId) === message.id
                    ? indexes.permissions
                        .get(message.runId)
                        ?.filter(
                          (item) =>
                            item.decisionSource !== 'automatic' &&
                            !permissionSubagentSource(snapshot, item),
                        )
                        .map((item) => (
                          <ChatApproval
                            key={item.id}
                            permission={item}
                            onOpen={() => setPermissionId(item.id)}
                          />
                        ))
                    : null}
                  {assistant ? (
                    hasText ? (
                      <Markdown
                        text={message.text}
                        streaming={run ? isActive(run) : false}
                        onLinkClick={onOpenLink ? chooseWebLink : undefined}
                      />
                    ) : run && isActive(run) ? null : (
                      <p className="message-placeholder">{t('conversation.noReply')}</p>
                    )
                  ) : (
                    <div className="user-message-bubble">
                      <div className="message-text">
                        <FormattedUserMessage text={message.text} />
                      </div>
                      {run ? <MessageContext run={run} attachments={indexes.attachments} /> : null}
                      {snapshot.session.fork &&
                      events.some((event) => event.type === 'sdk.context_restarted') ? (
                        <p className="message-placeholder">{t('conversation.branchRestored')}</p>
                      ) : null}
                    </div>
                  )}
                  <footer className="message-footer">
                    <time dateTime={message.createdAt} title={date(message.createdAt, timeFormat)}>
                      {date(message.createdAt, shortTimeFormat)}
                    </time>
                    {hasText ||
                    (hasMessageForkAnchor(message) && (onForkMessage || onRewindMessage)) ? (
                      <MessageActions
                        key={`${snapshot.session.id}:${message.id}`}
                        message={message}
                        disabled={submitting || snapshot.session.status === 'archived'}
                        onEdit={onEditMessage}
                        onQuote={onQuoteMessage}
                        onFork={onForkMessage}
                        onRewind={onRewindMessage}
                        subsequentMessageCount={subsequentMessageCounts.get(message.id)}
                        rewindDisabledReason={rewindDisabledReason}
                        forking={forkingMessageId === message.id}
                        forkDisabled={submitting || Boolean(forkingMessageId)}
                      />
                    ) : null}
                  </footer>
                  {assistant && run && runFooterOwners.get(message.runId) === message.id ? (
                    <BrowserToolNotice tools={tools} onTrace={() => onTrace(run.id)} />
                  ) : null}
                  {assistant && run && runFooterOwners.get(message.runId) === message.id ? (
                    <RunResult
                      run={run}
                      tools={tools}
                      hasArtifacts={artifacts.length > 0}
                      hasText={hasText}
                      retryDisabled={retryDisabled}
                      onRetry={onRetry}
                      onTrace={onTrace}
                    />
                  ) : null}
                  {assistant &&
                  run &&
                  !isActive(run) &&
                  runFooterOwners.get(message.runId) === message.id &&
                  artifacts.length > 0 ? (
                    <section
                      className="chat-deliverables"
                      aria-label={t('conversation.deliverables')}
                    >
                      <h3>{t('conversation.deliverables')}</h3>
                      <ul>
                        {artifacts.map((artifact) => (
                          <li key={artifact.id}>
                            <ArtifactAction artifact={artifact} showDownload />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </div>
              </article>
            );
          })
        ) : !snapshot.inheritedMessages?.length ? (
          <div className="welcome">
            <h2>{t('conversation.welcomeTitle')}</h2>
            <p>{t('conversation.welcomeHelp')}</p>
          </div>
        ) : null}
      </div>
      {onQuoteSelection &&
      !submitting &&
      snapshot.session.status !== 'archived' &&
      !webLink &&
      !outputTool &&
      !permission ? (
        <SelectionQuote viewport={viewport} onQuote={onQuoteSelection} />
      ) : null}
      {unseen ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="new-messages"
          onClick={() => {
            const element = viewport.current;
            nearBottom.current = true;
            if (element) element.scrollTop = element.scrollHeight;
            setUnseen(false);
          }}
        >
          <ArrowDown data-icon="inline-start" aria-hidden="true" />
          {hasPendingApproval ? t('conversation.pendingApproval') : t('conversation.newMessages')}
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
      {outputTool ? (
        <Suspense fallback={<p role="status">{t('conversation.openingOutput')}</p>}>
          <ToolOutputDialog
            key={outputTool.id}
            tool={outputTool}
            onOpenChange={(open) => {
              if (!open) setOutputToolId(undefined);
            }}
          />
        </Suspense>
      ) : null}
      {permission ? (
        <Suspense fallback={<p role="status">{t('conversation.openingApproval')}</p>}>
          <PermissionDialog
            key={permission.id}
            permission={permission}
            subagent={permissionSubagentSource(snapshot, permission)}
            onOpenChange={(open) => {
              if (!open) setPermissionId(undefined);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
