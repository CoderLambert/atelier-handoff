/**
 * @file 在当前对话轮次末尾展示运行状态与耗时。
 * @implementation 使用共用阶段模型显示当前状态，并根据运行开始时间与最近活动显示耗时。
 * @updated 2026-11-27T16:59:48+08:00
 */
import { useEffect, useState } from 'react';
import { LoaderCircle, Shield } from 'lucide-react';
import type { Run, RunEvent, ToolCall } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { useUiTranslation } from '@/i18n';
import { formatDate, formatDuration } from '@/utils/format';
import { deriveRunStage } from './run-stage';

export function RunLiveStatus({
  run,
  tools,
  events,
  subagents,
  stopPending,
}: {
  run: Run;
  tools: ToolCall[];
  events: RunEvent[];
  subagents: Snapshot['subagents'];
  stopPending?: boolean;
}) {
  const { t, locale } = useUiTranslation('chat');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const { key, label, status, activity } = deriveRunStage(
    { run, tools, events, notices: run.transcript?.notices, subagents, stopPending, now },
    t,
  );
  const lastTool = tools.at(-1);
  const lastActivityAt =
    activity?.at ?? lastTool?.endedAt ?? lastTool?.startedAt ?? run.startedAt ?? run.createdAt;
  const elapsed = Math.max(0, now - Date.parse(run.startedAt ?? run.createdAt));
  return (
    <section
      className="run-live-status"
      data-run-live-status
      data-run-id={run.id}
      data-status={status}
      aria-label={t('progress.label')}
      title={t('progress.lastActivity', { time: formatDate(lastActivityAt, locale) })}
    >
      {status === 'awaiting_permission' ? (
        <Shield aria-hidden="true" />
      ) : (
        <LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />
      )}
      <div className="run-live-status-copy">
        <span role="status">{label}</span>
        <span className="run-live-status-elapsed" data-run-elapsed>
          <span aria-hidden="true">· </span>
          {t('progress.elapsed', { duration: formatDuration(elapsed, locale) })}
        </span>
        {key === 'progress.waitingModel' && (
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
