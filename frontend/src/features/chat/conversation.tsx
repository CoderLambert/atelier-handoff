import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  Artifact,
  Attachment,
  Message,
  Permission,
  Run,
  RunEvent,
  ToolCall,
} from '@shared/types';
import { activeStatuses } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { ArtifactAction } from '@/features/inspector';
import { permissionOperation, StatusBadge } from '@/features/inspector/shared';
import { AttachmentPreview } from './attachment-preview';
import { Markdown } from './markdown';

const PermissionDialog = lazy(() => import('@/features/inspector/permission-dialog'));

export const isActive = (run: Run) => activeStatuses.includes(run.status);
const recoverable = (run: Run) => ['failed', 'stopped', 'interrupted'].includes(run.status);
const timeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const toolLabels: Record<string, string> = {
  Read: '读取文件',
  Skill: '加载 Skill',
  list_files: '列出文件',
  search_files: '搜索项目',
  edit_file: '编辑文件',
  write_file: '写入文件',
  delete_file: '删除文件',
  run_command: '运行命令',
  update_plan: '更新计划',
  publish_artifact: '发布交付物',
};
const toolStatuses: Record<ToolCall['status'], string> = {
  running: '进行中',
  awaiting_permission: '等待审批',
  succeeded: '成功',
  failed: '失败',
  denied: '已拒绝',
  canceled: '已取消',
};
const planStatuses = { pending: '待执行', in_progress: '进行中', completed: '已完成' };
const modelEvents = new Set([
  'sdk.initialized',
  'sdk.api_retry',
  'tool.started',
  'tool.finished',
  'message.delta',
]);
const EMPTY_TOOLS: ToolCall[] = [];
const EMPTY_EVENTS: RunEvent[] = [];
const EMPTY_ARTIFACTS: Artifact[] = [];

function toolLabel(name: string) {
  const short = name.replace(/^mcp__atelier__/, '');
  return toolLabels[short] || short;
}
function date(value: string) {
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
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const milliseconds = now - Date.parse(at);
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const duration =
    seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return <span>上次更新于 {duration}前</span>;
}

function RunProgress({
  run,
  tools,
  events,
  hasText,
}: {
  run: Run;
  tools: ToolCall[];
  events: RunEvent[];
  hasText: boolean;
}) {
  const ongoing = tools.find((tool) => tool.status === 'running');
  const finished = tools.filter((tool) => tool.endedAt);
  const last = finished.reduce<ToolCall | undefined>(
    (latest, tool) => (!latest || tool.endedAt! >= latest.endedAt! ? tool : latest),
    undefined,
  );
  const activity = events.findLast((event) => modelEvents.has(event.type));
  let stage = '正在等待模型回复';
  if (run.status === 'queued') stage = '等待执行';
  else if (run.status === 'awaiting_permission') stage = '等待操作审批';
  else if (run.status === 'stopping') stage = '正在停止';
  else if (ongoing) stage = `正在调用工具 · ${toolLabel(ongoing.name)}`;
  else if (activity?.type === 'sdk.api_retry') stage = '等待模型重试结果';
  else if (activity?.type === 'message.delta' && hasText) stage = '正在接收回复';
  else if (!activity && !tools.length && !hasText) stage = '正在启动模型会话';
  return (
    <section className="run-progress" aria-label="本轮执行进度">
      <div className="run-progress-head">
        <strong role="status">{stage}</strong>
        <ProgressClock at={events.at(-1)?.at || last?.endedAt || run.startedAt || run.createdAt} />
      </div>
      {tools.length > 0 ? (
        <p className="run-progress-tools">
          工具调用 {finished.length} / {tools.length} 已结束
          {last ? ` · 最近工具 ${toolLabel(last.name)}（${toolStatuses[last.status]}）` : ''}
        </p>
      ) : null}
      {run.plan.length > 0 ? (
        <details className="run-progress-plan">
          <summary>
            任务计划 · {run.plan.filter((step) => step.status === 'completed').length} /{' '}
            {run.plan.length} 已完成
          </summary>
          <ol>
            {run.plan.map((step, index) => (
              <li key={index}>
                {step.content} <small>{planStatuses[step.status]}</small>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
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
  if (isActive(run)) return null;
  const canRetry = recoverable(run);
  if (!canRetry && !hasArtifacts && (hasText || !tools.length)) return null;
  const title = canRetry ? (hasText ? '已保留部分回复' : '回复未完成') : '本轮执行结果';
  return (
    <section className="run-recovery" aria-label="本轮运行结果">
      <strong>{title}</strong>
      {run.error || run.reason ? <p>{run.error || run.reason}</p> : null}
      {tools.length > 0 ? (
        <p>
          已完成 {tools.filter((tool) => tool.status === 'succeeded').length} / {tools.length}{' '}
          次工具调用。
        </p>
      ) : null}
      <div className="run-recovery-actions">
        <Button
          type="button"
          variant="outline"
          className="btn btn-secondary"
          onClick={() => onTrace(run.id)}
        >
          查看执行轨迹
        </Button>
        {canRetry ? (
          <Button
            type="button"
            className="btn btn-primary"
            disabled={retryDisabled}
            onClick={() => onRetry(run.id)}
          >
            只读续接
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function MessageContext({ run, attachments }: { run: Run; attachments: Map<string, Attachment> }) {
  const references = [
    ...run.contextPaths.map((path) => ({
      key: `file:${path}`,
      label: `已读取 · 项目文件 · ${path}`,
    })),
    ...(run.extensions || []).map((extension) => ({
      key: `extension:${extension.id}`,
      label: `${extension.kind === 'mcp' ? 'MCP' : extension.kind === 'skill' ? 'Skill' : 'Command'} · ${extension.name}`,
    })),
  ];
  return references.length || run.attachmentIds.length ? (
    <ul className="message-context" aria-label="本轮已读取的上下文">
      {run.attachmentIds.map((id) => {
        const item = attachments.get(id);
        return item && !item.removed ? (
          <li key={`attachment:${id}`} className="message-attachment">
            <AttachmentPreview attachment={item}>附件 · {item.name}</AttachmentPreview>
          </li>
        ) : (
          <li key={`attachment:${id}`}>附件 · {item?.name ?? id} · 已不可用</li>
        );
      })}
      {references.map((reference) => (
        <li key={reference.key}>{reference.label}</li>
      ))}
    </ul>
  ) : null;
}

function ChatApproval({ permission, onOpen }: { permission: Permission; onOpen: () => void }) {
  const pending = permission.status === 'pending';
  return (
    <section className="chat-approval" data-pending={pending}>
      <div className="chat-approval-copy">
        <div className="chat-approval-title" role="status">
          <strong>{pending ? '需要你的审批' : permissionOperation(permission)}</strong>
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
        {pending ? '查看并审批' : '查看审批记录'}
      </Button>
    </section>
  );
}

export function Conversation({
  snapshot,
  onRetry,
  onTrace,
  submitting,
}: {
  snapshot: Snapshot;
  onRetry: (id: string) => void;
  onTrace: (id: string) => void;
  submitting: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const [permissionId, setPermissionId] = useState<string>();
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
  }, [snapshot.messages, snapshot.runs, snapshot.tools, snapshot.artifacts, snapshot.permissions]);
  useEffect(() => {
    if (!thread.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const element = viewport.current;
      if (element && nearBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(thread.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={viewport}
      id="conversation-content"
      className="conversation-content chat-conversation"
      role="region"
      aria-label="当前会话内容"
      tabIndex={0}
      onScroll={() => {
        const element = viewport.current;
        if (!element) return;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
        if (nearBottom.current) setUnseen(false);
      }}
    >
      <div ref={thread} className="message-thread" data-session-id={snapshot.session.id}>
        {messages.length ? (
          messages.map((message) => {
            const assistant = message.role === 'assistant';
            const run = indexes.runs.get(message.runId);
            const tools = indexes.tools.get(message.runId) || EMPTY_TOOLS;
            const events = indexes.events.get(message.runId) || EMPTY_EVENTS;
            const artifacts = indexes.artifacts.get(message.runId) || EMPTY_ARTIFACTS;
            const hasText = Boolean(message.text.trim());
            return (
              <article
                key={message.id}
                className={`message ${assistant ? 'assistant-message' : 'user-message'}`}
                data-message-id={message.id}
                data-run-id={message.runId}
              >
                <div
                  className={`avatar ${assistant ? 'ai-avatar' : 'user-avatar'}`}
                  aria-hidden="true"
                >
                  {assistant ? 'A' : '我'}
                </div>
                <div className="message-body">
                  <div className="message-meta">
                    <strong>{assistant ? 'atelier' : '你'}</strong>
                    <time dateTime={message.createdAt}>{date(message.createdAt)}</time>
                  </div>
                  {assistant && run && isActive(run) ? (
                    <RunProgress run={run} tools={tools} events={events} hasText={hasText} />
                  ) : null}
                  {assistant && runFooterOwners.get(message.runId) === message.id
                    ? indexes.permissions
                        .get(message.runId)
                        ?.map((item) => (
                          <ChatApproval
                            key={item.id}
                            permission={item}
                            onOpen={() => setPermissionId(item.id)}
                          />
                        ))
                    : null}
                  {assistant ? (
                    hasText ? (
                      <Markdown text={message.text} streaming={run ? isActive(run) : false} />
                    ) : run && isActive(run) ? null : (
                      <p className="message-placeholder">本轮没有文字回复</p>
                    )
                  ) : (
                    <div className="message-text">{message.text}</div>
                  )}
                  {!assistant && run ? (
                    <MessageContext run={run} attachments={indexes.attachments} />
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
                    <section className="chat-deliverables" aria-label="本轮交付物">
                      <h3>本轮交付物</h3>
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
        ) : (
          <div className="welcome">
            <h2>这次想做什么？</h2>
            <p>描述任务，或先添加要讨论的项目文件。</p>
          </div>
        )}
      </div>
      {unseen ? (
        <Button
          type="button"
          variant="outline"
          className="new-messages btn btn-secondary"
          onClick={() => {
            const element = viewport.current;
            nearBottom.current = true;
            if (element) element.scrollTop = element.scrollHeight;
            setUnseen(false);
          }}
        >
          {hasPendingApproval ? '有待审批操作 ↓' : '查看新消息 ↓'}
        </Button>
      ) : null}
      {permission ? (
        <Suspense fallback={<p role="status">正在打开审批…</p>}>
          <PermissionDialog
            key={permission.id}
            permission={permission}
            onOpenChange={(open) => {
              if (!open) setPermissionId(undefined);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
