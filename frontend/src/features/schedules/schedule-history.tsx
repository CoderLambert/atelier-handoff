/**
 * @file 展示定时任务的运行历史记录列表。
 * @implementation 显示触发类型、执行状态、提示词快照与错误原因，并支持一键跳转到关联会话。
 * @updated 2026-11-27T13:30:00+08:00
 */
import { ArrowUpRight, Clock } from 'lucide-react';
import type { ScheduledTaskRun } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';

function statusVariant(status: ScheduledTaskRun['status']) {
  switch (status) {
    case 'completed':
      return 'secondary' as const;
    case 'failed':
      return 'destructive' as const;
    default:
      return 'outline' as const;
  }
}

export function ScheduleHistory({
  runs,
  loading,
  onOpenSession,
}: {
  runs: readonly ScheduledTaskRun[];
  loading: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t, locale } = useUiTranslation('schedules');
  const formatTime = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(iso));

  if (loading && runs.length === 0) {
    return <p className="schedules-muted">…</p>;
  }
  if (runs.length === 0) {
    return <p className="schedules-muted">{t('meta.historyEmpty')}</p>;
  }

  return (
    <ul className="schedules-history-list">
      {runs.map((entry) => (
        <li key={entry.id} className="schedules-history-item">
          <div className="schedules-history-head">
            <span className="schedules-history-time">
              <Clock className="size-3.5" aria-hidden="true" />
              {formatTime(entry.createdAt)}
            </span>
            <div className="schedules-history-badges">
              <Badge variant="outline">{t(`trigger.${entry.triggerKind}`)}</Badge>
              <Badge variant={statusVariant(entry.status)}>{t(`runStatus.${entry.status}`)}</Badge>
              {entry.targetSessionId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenSession(entry.targetSessionId!)}
                >
                  {t('actions.open')}
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Button>
              ) : null}
            </div>
          </div>
          <p className="schedules-history-prompt">{entry.promptSnapshot}</p>
          {entry.error ? (
            <p className="schedules-history-error" role="alert">
              {entry.error}
            </p>
          ) : entry.skipReason ? (
            <p className="schedules-muted">{entry.skipReason}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
