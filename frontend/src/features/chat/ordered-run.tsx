/**
 * @file 按运行时到达顺序展示正文、工具和可见通知。
 * @implementation 从单轮切片投影正文、工具和通知，复用对话页脚与摘要，并比较实体引用以隔离历史渲染。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { memo, useId, useMemo, useState, type ReactNode } from 'react';
import type { Permission, ToolCall } from '@shared/types';
import { cn } from '@/components/ui/utils';
import { useUiTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { ToolDetail } from '@/features/inspector/tool-detail';
import { toolDisplayStatus, toolOutputView } from '@/features/inspector/tool-detail-format';
import { SubagentProgress, groupRunWork } from '@/features/inspector';
import {
  parseScheduledTaskFromTool,
  ScheduledRunBanner,
  ScheduledTaskCard,
} from '@/features/schedules/schedule-card';
import {
  ChatApproval,
  MessageFooter,
  RunEndSummary,
  UserMessageBubble,
} from './conversation-turn-parts';
import { areOrderedTurnPropsEqual, isActive, type OrderedTurnProps } from './conversation-turns';
import { Markdown } from './markdown';
import { orderedTranscriptRows, type TranscriptRow } from './ordered-transcript-model';

function TranscriptNoticeRow({
  notice,
}: Pick<Extract<TranscriptRow, { kind: 'notice' }>, 'notice'>) {
  const { t } = useUiTranslation('chat');
  return (
    <p
      className="transcript-notice"
      role="status"
      data-transcript-kind="notice"
      data-transcript-order={notice.order}
      data-transcript-notice-kind={notice.kind}
    >
      {notice.kind === 'api_error'
        ? t('transcript.apiError', { code: notice.code })
        : notice.kind === 'tool_preparing'
          ? t('transcript.toolPreparing', { name: notice.toolName })
          : notice.kind === 'tool_interrupted'
            ? t('transcript.toolInterrupted', { name: notice.toolName })
            : t('transcript.toolBlocked', { name: notice.toolName })}
    </p>
  );
}

function TranscriptTools({
  tools,
  permissions,
  onPermission,
  onOutput,
  children,
}: {
  tools: ToolCall[];
  permissions: Permission[];
  onPermission: (permission: Permission) => ReactNode;
  onOutput: (tool: ToolCall) => void;
  children: (tool: ToolCall) => ReactNode;
}) {
  const { t } = useUiTranslation('chat');
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const foldable =
    tools.length > 1 &&
    tools.every((tool) => toolDisplayStatus(tool, toolOutputView(tool)) === 'succeeded') &&
    !permissions.some((permission) => permission.status === 'pending');
  const open = !foldable || expanded || pinned;
  return (
    <div
      className="transcript-tools"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPinned(false);
      }}
    >
      {foldable ? (
        <Button
          key="toggle"
          type="button"
          variant="ghost"
          size="xs"
          data-preserve-scroll
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            setPinned(false);
            setExpanded(!open);
          }}
        >
          {t('transcript.readBatch', { count: tools.length })}
        </Button>
      ) : null}
      <div
        key="tools"
        id={id}
        hidden={!open}
        className="transcript-tool-list"
        onFocusCapture={() => setPinned(true)}
      >
        {tools.map((tool) => (
          <div
            key={tool.id}
            data-transcript-kind="tool"
            data-transcript-order={tool.transcriptOrder}
            data-run-id={tool.runId}
          >
            <ToolDetail
              tool={tool}
              variant="compact"
              automaticallyApproved={permissions.some(
                (permission) =>
                  permission.toolCallId === tool.id && permission.decisionSource === 'automatic',
              )}
              onOutput={() => onOutput(tool)}
            />
            {permissions
              .filter(
                (permission) =>
                  permission.toolCallId === tool.id && permission.decisionSource !== 'automatic',
              )
              .map((permission) => (
                <div key={permission.id}>{onPermission(permission)}</div>
              ))}
            {children(tool)}
          </div>
        ))}
      </div>
    </div>
  );
}

export const OrderedRun = memo(function OrderedRun(props: OrderedTurnProps) {
  const { t } = useUiTranslation('chat');
  const { turn, sessionId, actions, hasFork } = props;
  const { slice, hasGlobalLastMessage, lastRealMessageId } = turn;
  const { run, messages, tools, permissions, subagents, attachments, contextRestarted } = slice;
  const { onPermission, onOutput, onOpenSchedule, onLinkClick } = actions;
  const onTrace = () => actions.onTrace(run.id);
  const renderPermission = (item: Permission) => (
    <ChatApproval permission={item} onPermission={onPermission} />
  );
  const rows = useMemo(() => orderedTranscriptRows(run, messages, tools), [run, messages, tools]);
  const work = useMemo(
    () => groupRunWork({ session: { id: sessionId }, tools, permissions, subagents }, run),
    [sessionId, tools, permissions, subagents, run],
  );
  const childProgress = (groups: typeof work.subagents) => (
    <SubagentProgress
      groups={groups}
      run={run}
      onPermission={onPermission}
      onToolOutput={onOutput}
      onTrace={onTrace}
    />
  );
  const positionedToolIds = new Set(
    work.tools.filter((tool) => tool.transcriptOrder !== undefined).map((tool) => tool.id),
  );
  const latestContentOrder = rows.findLast(
    (row) => row.kind === 'text' || row.kind === 'user',
  )?.order;
  const scheduleCards = useMemo(
    () =>
      tools
        .map((tool) => parseScheduledTaskFromTool(tool))
        .filter((task): task is NonNullable<typeof task> => task !== undefined),
    [tools],
  );
  return (
    <section className="ordered-run" data-run-id={run.id}>
      {run.scheduleMeta ? (
        <ScheduledRunBanner meta={run.scheduleMeta} onOpen={onOpenSchedule} />
      ) : null}
      {rows.map((row) => (
        <div key={row.key}>
          {row.kind === 'tool' ? (
            <TranscriptTools
              tools={row.tools}
              permissions={work.permissions}
              onPermission={renderPermission}
              onOutput={onOutput}
            >
              {(tool) => childProgress(work.subagents.filter((group) => group.id === tool.id))}
            </TranscriptTools>
          ) : row.kind === 'notice' ? (
            <TranscriptNoticeRow notice={row.notice} />
          ) : (
            <article
              className={cn('message', row.kind === 'text' ? 'assistant-message' : 'user-message')}
              aria-label={t(row.kind === 'text' ? 'conversation.assistant' : 'conversation.you')}
              data-message-id={row.message.id}
              data-run-id={run.id}
              data-transcript-kind={row.kind}
              data-last-message={
                (row.order === latestContentOrder && hasGlobalLastMessage) || undefined
              }
              data-transcript-order={row.order}
              data-transcript-part-id={row.kind === 'text' ? row.key : undefined}
            >
              <div className="message-body">
                {row.kind === 'text' ? (
                  <Markdown
                    text={row.text}
                    streaming={isActive(run) && row.footer}
                    onLinkClick={onLinkClick}
                  />
                ) : (
                  <UserMessageBubble
                    text={row.text}
                    run={run}
                    attachments={attachments}
                    contextRestarted={hasFork && contextRestarted}
                  />
                )}
                {row.footer ? (
                  <MessageFooter
                    message={row.message}
                    at={row.at}
                    hasSubsequent={row.message.id !== lastRealMessageId}
                    state={props}
                  />
                ) : null}
              </div>
            </article>
          )}
        </div>
      ))}
      {childProgress(work.subagents.filter((group) => !positionedToolIds.has(group.id)))}
      {work.permissions
        .filter(
          (permission) =>
            !positionedToolIds.has(permission.toolCallId) &&
            permission.decisionSource !== 'automatic',
        )
        .map((permission) => (
          <div key={permission.id}>{renderPermission(permission)}</div>
        ))}
      {scheduleCards.map((task) => (
        <ScheduledTaskCard key={task.id} task={task} onOpen={onOpenSchedule} />
      ))}
      <RunEndSummary slice={slice} state={props} />
    </section>
  );
}, areOrderedTurnPropsEqual);
