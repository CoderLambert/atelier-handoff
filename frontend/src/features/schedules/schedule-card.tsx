/**
 * @file 提供对话内嵌的定时任务卡片与定时触发标识组件。
 * @implementation 解析 create/update_scheduled_task 工具输出并渲染可点击打开右侧详情面板的任务卡片，同时为带 scheduleMeta 的运行渲染触发头。
 * @updated 2026-11-27T13:48:00+08:00
 */
import { Clock } from 'lucide-react';
import {
  scheduledTaskSchema,
  type RunScheduleMeta,
  type ScheduledTask,
  type ToolCall,
} from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';

const SCHEDULE_TOOL_NAMES = new Set([
  'mcp__atelier__create_scheduled_task',
  'mcp__atelier__update_scheduled_task',
]);

export function parseScheduledTaskFromTool(tool: ToolCall): ScheduledTask | undefined {
  if (!SCHEDULE_TOOL_NAMES.has(tool.name) || tool.status !== 'succeeded' || !tool.output) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(tool.output);
    if (typeof parsed !== 'object' || parsed === null || !('task' in parsed)) return undefined;
    const result = scheduledTaskSchema.safeParse((parsed as { task: unknown }).task);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function formatScheduleSummary(
  task: Pick<ScheduledTask, 'timing' | 'timeZone'>,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const { timing, timeZone } = task;
  switch (timing.kind) {
    case 'daily':
      return `${t('timing.daily')} ${timing.time} (${timeZone})`;
    case 'weekly': {
      const days = timing.weekdays.map((day) => t(`weekday.${day}`)).join(' / ');
      return `${t('timing.weekly')} ${days} ${timing.time} (${timeZone})`;
    }
    case 'interval':
      return `${t('timing.interval')} ${Math.round(timing.everySeconds / 60)}m (${timeZone})`;
    case 'once':
      return `${t('timing.once')} ${timing.runAt} (${timeZone})`;
    case 'cron':
      return `${timing.expression} (${timeZone})`;
  }
}

export function ScheduledTaskCard({
  task,
  onOpen,
}: {
  task: ScheduledTask;
  onOpen?: (taskId: string) => void;
}) {
  const { t } = useUiTranslation('schedules');
  const summary = formatScheduleSummary(task, (key) => t(key as never));
  return (
    <div className="schedule-chat-card" data-schedule-task-id={task.id}>
      <div className="schedule-chat-card-main">
        <span className="schedule-chat-card-icon" aria-hidden="true">
          <Clock className="size-4" />
        </span>
        <div className="schedule-chat-card-text">
          <div className="schedule-chat-card-title">
            <span>{task.title}</span>
            <Badge variant={task.status === 'active' ? 'default' : 'secondary'}>
              {t(`status.${task.status}`)}
            </Badge>
          </div>
          <p className="schedule-chat-card-meta">{summary}</p>
        </div>
      </div>
      {onOpen ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onOpen(task.id)}>
          {t('actions.open')}
        </Button>
      ) : null}
    </div>
  );
}

export function ScheduledRunBanner({
  meta,
  onOpen,
}: {
  meta: RunScheduleMeta;
  onOpen?: (taskId: string) => void;
}) {
  const { t, locale } = useUiTranslation('schedules');
  const formatted = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(meta.scheduledFor));
  return (
    <div className="schedule-run-banner" data-schedule-task-id={meta.taskId}>
      <span className="schedule-run-banner-label">
        <Clock className="size-3.5" aria-hidden="true" />
        <strong>{t('chat.triggeredBadge')}</strong>
        <span>·</span>
        <span>{meta.taskName}</span>
      </span>
      <span className="schedule-run-banner-right">
        <span>{formatted}</span>
        {onOpen ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => onOpen(meta.taskId)}>
            {t('actions.open')}
          </Button>
        ) : null}
      </span>
    </div>
  );
}
