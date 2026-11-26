/**
 * @file 按运行时到达顺序展示正文、工具和重试通知。
 * @implementation 工具沿用稳定标识原位更新，审批与子任务随所属工具显示，相邻成功只读调用可折叠。
 * @updated 2026-11-26T01:10:00+08:00
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import type { Message, Permission, Run, ToolCall } from '@shared/types';
import type { TranscriptNotice } from '@shared/ordered-transcript';
import type { Snapshot } from '@/api/types';
import { useUiTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { ToolDetail } from '@/features/inspector/tool-detail';
import { toolDisplayStatus, toolOutputView } from '@/features/inspector/tool-detail-format';
import { SubagentProgress, groupRunWork } from '@/features/inspector';
import { orderedTranscriptRows, type TranscriptRow } from './ordered-transcript-model';

function TranscriptNoticeRow({ notice }: { notice: TranscriptNotice }) {
  const { t } = useUiTranslation('chat');
  return (
    <p
      className="transcript-notice"
      role="status"
      data-transcript-kind="notice"
      data-transcript-order={notice.order}
      data-transcript-notice-kind={notice.kind}
    >
      {notice.kind === 'api_retry'
        ? t('transcript.retry', { attempt: notice.attempt, maxRetries: notice.maxRetries })
        : notice.kind === 'api_error'
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

export function OrderedRun({
  snapshot,
  run,
  renderMessage,
  renderPermission,
  onPermission,
  onOutput,
  onTrace,
  summary,
}: {
  snapshot: Snapshot;
  run: Run;
  renderMessage: (row: Extract<TranscriptRow, { message: Message }>, latest: boolean) => ReactNode;
  renderPermission: (permission: Permission) => ReactNode;
  onPermission: (permission: Permission) => void;
  onOutput: (tool: ToolCall) => void;
  onTrace: () => void;
  summary: ReactNode;
}) {
  const rows = useMemo(
    () => orderedTranscriptRows(run, snapshot.messages, snapshot.tools),
    [run, snapshot.messages, snapshot.tools],
  );
  const work = useMemo(() => groupRunWork(snapshot, run), [snapshot, run]);
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
  return (
    <section className="ordered-run" data-run-id={run.id}>
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
            renderMessage(row, row.order === latestContentOrder)
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
      {summary}
    </section>
  );
}
