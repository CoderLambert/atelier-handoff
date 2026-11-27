/**
 * @file 展示旧对话运行的进度与折叠历史，以及共享运行摘要。
 * @implementation 复用阶段模型和子任务归组，按运行切片渲染等待状态、工具与任务清单。
 * @updated 2026-11-27T19:30:00+08:00
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { Activity, ChevronRight } from 'lucide-react';
import type { Permission, Run, RunEvent, ToolCall } from '@shared/types';
import type { Subagent } from '@shared/subagents';
import { useUiTranslation } from '@/i18n';
import { Button } from '@/components/ui/button';
import { SubagentProgress, groupRunWork } from '@/features/inspector';
import { statusLabel } from '@/features/inspector/shared';
import { formatDate, formatDuration } from '@/utils/format';
import { isActive } from './conversation-turns';
import { RunToolActivity } from './run-tool-activity';
import { deriveRunStage, receivingWindowMs } from './run-stage';
import { TaskPlan } from './task-plan';

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

export function RunSummary({
  run,
  tools,
  history,
  onTrace,
}: {
  run: Run;
  tools: readonly ToolCall[];
  history?: { open: boolean; contentId: string; onToggle: () => void };
  onTrace: () => void;
}) {
  const { t, locale } = useUiTranslation('chat');
  const duration =
    run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : NaN;
  const status = statusLabel(run.status);
  const summary =
    Number.isFinite(duration) && duration >= 0
      ? t('progress.historyDuration', { status, duration: formatDuration(duration, locale) })
      : status;
  const completed = tools.filter((tool) => tool.status === 'succeeded').length;
  const content = (
    <>
      <span>{summary}</span>
      {tools.length ? (
        <span
          className="run-summary-tools"
          title={t('conversation.toolsCompleted', { completed, count: tools.length })}
        >
          {t('conversation.toolSummary', { completed, count: tools.length })}
        </span>
      ) : null}
    </>
  );
  return (
    <div className="run-summary" data-status={run.status}>
      {history ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="run-history-toggle"
          data-preserve-scroll
          title={t('progress.history')}
          aria-expanded={history.open}
          aria-controls={history.contentId}
          onClick={history.onToggle}
        >
          {content}
          <ChevronRight data-icon="inline-end" aria-hidden="true" />
        </Button>
      ) : (
        <span className="run-history-status">{content}</span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('conversation.viewTrace')}
        title={t('conversation.viewTrace')}
        onClick={onTrace}
      >
        <Activity aria-hidden="true" />
      </Button>
    </div>
  );
}

export function RunProgress({
  run,
  tools,
  events,
  hasText,
  sessionId,
  permissions,
  subagents,
  showPlan,
  onPermission,
  onOutput,
  onTrace,
  stopPending,
}: {
  run: Run;
  tools: readonly ToolCall[];
  events: readonly RunEvent[];
  hasText: boolean;
  sessionId: string;
  permissions: readonly Permission[];
  subagents: readonly Subagent[];
  showPlan: boolean;
  onPermission: (permission: Permission) => void;
  onOutput: (tool: ToolCall) => void;
  onTrace: () => void;
  stopPending?: boolean;
}) {
  const { t, locale } = useUiTranslation('chat');
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const work = useMemo(
    () => groupRunWork({ session: { id: sessionId }, subagents, tools, permissions }, run),
    [sessionId, subagents, tools, permissions, run],
  );
  const active = isActive(run);
  const now = Date.now();
  const {
    key,
    label: stage,
    status,
    activity,
  } = deriveRunStage(
    {
      run,
      tools,
      events,
      notices: run.transcript?.notices,
      subagents,
      stopPending,
      now,
    },
    t,
  );
  const [, refreshStage] = useState(0);
  useEffect(() => {
    if (!active || key !== 'progress.receiving' || !activity) return;
    const delay = Math.max(0, Date.parse(activity.at) + receivingWindowMs - Date.now());
    const timer = window.setTimeout(() => refreshStage((value) => value + 1), delay);
    return () => window.clearTimeout(timer);
  }, [active, key, activity]);
  const approved = useMemo(
    () =>
      new Set(
        work.permissions.filter((p) => p.decisionSource === 'automatic').map((p) => p.toolCallId),
      ),
    [work],
  );
  const hasDetails = work.tools.length > 0 || work.subagents.length > 0 || showPlan;
  const isPureModelWaiting =
    !hasDetails &&
    (key === 'progress.waitingModel' ||
      key === 'progress.starting' ||
      key === 'progress.receiving');
  if (active && isPureModelWaiting) {
    if (hasText) return null;
    return <ModelLoadingIndicator label={t('progress.waitingModel')} />;
  }
  const lastTool = tools.at(-1);
  const lastActivityAt =
    events.at(-1)?.at ?? lastTool?.endedAt ?? lastTool?.startedAt ?? run.startedAt ?? run.createdAt;
  const liveHeading = active ? (
    <div
      className="run-progress-head"
      title={t('progress.lastActivity', { time: formatDate(lastActivityAt, locale) })}
    >
      {key === 'progress.waitingModel' ? (
        <div className="run-progress-loading-inline" role="status" aria-label={stage}>
          <span className="model-loading-dot" />
          <span className="model-loading-dot" />
          <span className="model-loading-dot" />
          <span className="sr-only">{stage}</span>
        </div>
      ) : (
        <strong role="status">{stage}</strong>
      )}
    </div>
  ) : null;
  return (
    <section
      className="run-progress"
      data-status={status}
      data-active={active}
      aria-label={active ? t('progress.label') : t('progress.history')}
    >
      {!active ? (
        <RunSummary
          run={run}
          tools={tools}
          history={
            hasDetails
              ? {
                  open: historyOpen,
                  contentId: historyId,
                  onToggle: () => setHistoryOpen(!historyOpen),
                }
              : undefined
          }
          onTrace={onTrace}
        />
      ) : null}
      {work.tools.length ? null : liveHeading}
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
              liveHeading={liveHeading}
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
            run={status === run.status ? run : { ...run, status }}
            onPermission={onPermission}
            onToolOutput={onOutput}
            onTrace={onTrace}
          />
        </div>
      ) : null}
    </section>
  );
}
