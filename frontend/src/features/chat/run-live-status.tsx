/**
 * @file 在当前对话轮次末尾展示运行状态与耗时。
 * @implementation 根据运行状态、工具、事件和子任务选择阶段，显示整轮耗时，并在等待模型时显示距最近活动的时间。
 * @updated 2026-11-27T03:03:08+08:00
 */
import { useEffect, useState } from 'react';
import { LoaderCircle, Shield } from 'lucide-react';
import type { Run, RunEvent, ToolCall } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { useUiTranslation } from '@/i18n';
import { formatDate, formatDuration } from '@/utils/format';

export function RunLiveStatus({
  run,
  tools,
  events,
  subagents,
}: {
  run: Run;
  tools: ToolCall[];
  events: RunEvent[];
  subagents: Snapshot['subagents'];
}) {
  const { t, locale } = useUiTranslation('chat');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const runningSubagents = subagents?.filter(
    (agent) => agent.runId === run.id && agent.status === 'running',
  );
  const ongoing = tools.findLast(
    (tool) =>
      tool.status === 'running' &&
      !tool.subagentId &&
      tool.bashExecution?.phase !== 'background' &&
      !runningSubagents?.some((task) => task.id === tool.id),
  );
  const event = events.findLast((event) =>
    [
      'sdk.initialized',
      'sdk.api_retry',
      'tool.started',
      'tool.finished',
      'subagent.started',
      'subagent.finished',
      'message.delta',
    ].includes(event.type),
  );
  const preparing = run.transcript?.notices.findLast((notice) => notice.kind === 'tool_preparing');
  let stage: string = t('progress.waitingModel');
  if (run.status === 'queued') stage = t('progress.queued');
  else if (run.status === 'awaiting_permission') stage = t('progress.awaitingApproval');
  else if (run.status === 'stopping') stage = t('progress.stopping');
  else if (ongoing?.bashExecution?.phase === 'stopping') stage = t('progress.stoppingBash');
  else if (ongoing)
    stage = t('progress.callingTool', { name: ongoing.name.replace(/^mcp__atelier__/, '') });
  else if (preparing?.kind === 'tool_preparing')
    stage = t('transcript.toolPreparing', {
      name: preparing.toolName.replace(/^mcp__atelier__/, ''),
    });
  else if (event?.type === 'message.delta' && now - Date.parse(event.at) < 2000)
    stage = t('progress.receiving');
  else if (runningSubagents?.length)
    stage = t('progress.runningSubtasks', { count: runningSubagents.length });
  else if (event?.type === 'sdk.api_retry') stage = t('progress.retryingModel');
  else if (
    tools.some((tool) => tool.status === 'running' && tool.bashExecution?.phase === 'background')
  )
    stage = t('progress.backgroundBash');
  else if (!event && !tools.length) stage = t('progress.starting');
  const lastTool = tools.at(-1);
  const lastActivityAt =
    event?.at ?? lastTool?.endedAt ?? lastTool?.startedAt ?? run.startedAt ?? run.createdAt;
  const elapsed = Math.max(0, now - Date.parse(run.startedAt ?? run.createdAt));
  return (
    <section
      className="run-live-status"
      data-run-live-status
      data-run-id={run.id}
      data-status={run.status}
      aria-label={t('progress.label')}
      title={t('progress.lastActivity', { time: formatDate(lastActivityAt, locale) })}
    >
      {run.status === 'awaiting_permission' ? (
        <Shield aria-hidden="true" />
      ) : (
        <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
      )}
      <div className="run-live-status-copy">
        <span role="status">{stage}</span>
        <span className="run-live-status-elapsed" data-run-elapsed>
          <span aria-hidden="true">· </span>
          {t('progress.elapsed', { duration: formatDuration(elapsed, locale) })}
        </span>
        {stage === t('progress.waitingModel') && (
          <span className="run-live-status-elapsed" data-run-since-activity>
            <span aria-hidden="true">· </span>
            {t('progress.sinceActivity', {
              duration: formatDuration(Math.max(0, now - Date.parse(lastActivityAt)), locale),
            })}
          </span>
        )}
      </div>
    </section>
  );
}
