/**
 * @file 提供工作台右侧受控的定时任务详情面板。
 * @implementation 复用 PanelLayoutButtons、Radix Select 任务切换器与规则表单/运行历史双页签。
 * @updated 2026-11-27T23:59:00+08:00
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Clock, Pause, Play, Trash2, Zap } from 'lucide-react';
import type { Project, Session } from '@shared/types';
import { PanelLayoutButtons } from '@/components/panel-layout-buttons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUiTranslation } from '@/i18n';
import type { PanelViewProps } from '@/panel-sdk';
import { useDeleteSchedule } from '@/use-query/schedules/use-delete-schedule';
import { useRunScheduleNow } from '@/use-query/schedules/use-run-schedule-now';
import { useScheduleRuns } from '@/use-query/schedules/use-schedule-runs';
import { useSchedules } from '@/use-query/schedules/use-schedules';
import { useUpdateSchedule } from '@/use-query/schedules/use-update-schedule';
import { useBootstrap } from '@/use-query/workspace/use-bootstrap';
import { ScheduleForm } from './schedule-form';
import { ScheduleHistory } from './schedule-history';
import { ScheduleTriggerSection } from './schedule-trigger-section';
import './schedules.css';

export function ScheduleInspectorPanel({
  projectId,
  initialTaskId,
  projects,
  sessions,
  layout,
  onOpenSession,
  onDeleted,
}: {
  projectId: string;
  initialTaskId?: string;
  projects: readonly Project[];
  sessions: readonly Session[];
  layout: Pick<PanelViewProps, 'expanded' | 'expandable' | 'onRequestHide' | 'onRequestExpand'>;
  onOpenSession: (sessionId: string) => void;
  onDeleted?: () => void;
}) {
  const { t, locale } = useUiTranslation('schedules');
  const [selectedId, setSelectedId] = useState<string | undefined>(initialTaskId);
  const [tab, setTab] = useState<'rules' | 'history'>('rules');

  useEffect(() => {
    if (initialTaskId) setSelectedId(initialTaskId);
  }, [initialTaskId]);

  const bootstrap = useBootstrap();
  const nativeExecution = bootstrap.data?.capabilities.nativeExecution === true;
  const schedulesQuery = useSchedules(projectId);
  const tasks = schedulesQuery.data ?? [];
  const activeTask = useMemo(
    () => tasks.find((item) => item.id === selectedId) ?? tasks[0],
    [selectedId, tasks],
  );
  const runsQuery = useScheduleRuns(activeTask?.id);

  const updateMutation = useUpdateSchedule();
  const deleteMutation = useDeleteSchedule();
  const runNowMutation = useRunScheduleNow();

  const formatDateTime = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));

  return (
    <div className="schedule-right-panel">
      <header className="schedule-right-panel-header">
        <div className="schedule-right-panel-heading">
          <Clock className="size-4 shrink-0" aria-hidden="true" />
          <span className="schedule-right-panel-title">{activeTask?.title ?? t('title')}</span>
        </div>
        <div className="schedule-right-panel-controls">
          {tasks.length > 1 && activeTask ? (
            <Select value={activeTask.id} onValueChange={setSelectedId}>
              <SelectTrigger size="sm" className="w-36" aria-label={t('title')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {tasks.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <PanelLayoutButtons
            layout={layout}
            expandLabel={t('panel.expand')}
            dockLabel={t('panel.dock')}
            collapseLabel={t('panel.collapse')}
          />
        </div>
      </header>

      <div className="schedule-right-panel-body">
        {activeTask ? (
          <>
            <div className="schedules-detail-head">
              <div className="schedules-detail-heading">
                <div className="schedules-detail-title-row">
                  <Badge
                    variant={
                      activeTask.status === 'active'
                        ? 'default'
                        : activeTask.status === 'paused'
                          ? 'secondary'
                          : 'outline'
                    }
                  >
                    {t(`status.${activeTask.status}`)}
                  </Badge>
                  <p className="schedules-muted">
                    {activeTask.nextRunAt
                      ? t('meta.nextRun', { time: formatDateTime(activeTask.nextRunAt) })
                      : t('meta.noNextRun')}
                  </p>
                </div>
              </div>
              <div className="schedules-detail-actions">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  disabled={runNowMutation.isPending}
                  onClick={() => runNowMutation.mutate(activeTask.id)}
                >
                  <Zap className="size-3.5" aria-hidden="true" />
                  <span>{t('actions.runNow')}</span>
                </Button>
                {activeTask.status === 'active' ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={updateMutation.isPending}
                    onClick={() =>
                      updateMutation.mutate({
                        id: activeTask.id,
                        patch: { expectedUpdatedAt: activeTask.updatedAt, status: 'paused' },
                      })
                    }
                  >
                    <Pause className="size-3.5" aria-hidden="true" />
                    <span>{t('actions.pause')}</span>
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={updateMutation.isPending}
                    onClick={() =>
                      updateMutation.mutate({
                        id: activeTask.id,
                        patch: { expectedUpdatedAt: activeTask.updatedAt, status: 'active' },
                      })
                    }
                  >
                    <Play className="size-3.5" aria-hidden="true" />
                    <span>{t('actions.resume')}</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    deleteMutation.mutate(activeTask.id, {
                      onSuccess: () => {
                        setSelectedId(undefined);
                        onDeleted?.();
                      },
                    });
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  <span>{t('actions.delete')}</span>
                </Button>
              </div>
            </div>

            <div className="schedules-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'rules'}
                className={tab === 'rules' ? 'schedules-tab schedules-tab-active' : 'schedules-tab'}
                onClick={() => setTab('rules')}
              >
                {t('tabs.rules')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'history'}
                className={
                  tab === 'history' ? 'schedules-tab schedules-tab-active' : 'schedules-tab'
                }
                onClick={() => setTab('history')}
              >
                {t('tabs.history')}
              </button>
            </div>

            {tab === 'rules' ? (
              <>
                <ScheduleForm
                  mode="edit"
                  task={activeTask}
                  projects={projects}
                  sessions={sessions}
                  nativeExecution={nativeExecution}
                  pending={updateMutation.isPending}
                  error={
                    updateMutation.error?.message ??
                    runNowMutation.error?.message ??
                    deleteMutation.error?.message
                  }
                  onUpdate={(id, patch) => updateMutation.mutate({ id, patch })}
                />
                <ScheduleTriggerSection task={activeTask} />
              </>
            ) : (
              <ScheduleHistory
                runs={runsQuery.data ?? []}
                loading={runsQuery.isLoading}
                onOpenSession={onOpenSession}
              />
            )}

            {activeTask.targetSessionId ? (
              <div className="schedules-footer-link">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenSession(activeTask.targetSessionId!)}
                >
                  <span>{t('actions.openSession')}</span>
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="schedules-empty">
            <div className="schedules-empty-icon" aria-hidden="true">
              <Clock className="size-5" />
            </div>
            <h2 className="schedules-empty-title">{t('emptyTitle')}</h2>
            <p className="schedules-empty-copy">{t('emptyDescription')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
