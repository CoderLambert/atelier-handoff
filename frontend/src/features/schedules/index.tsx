/**
 * @file 提供工作台自动化定时任务的全局管理页面。
 * @implementation 左侧按项目筛选并展示任务清单，右侧提供 DSH 风格的「规则 / 任务运行记录」双页签与暂停、立即执行、删除及会话跳转动作。
 * @updated 2026-11-27T13:30:00+08:00
 */
import { useMemo, useState } from 'react';
import { ArrowUpRight, Clock, Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import type { Project, ScheduledTask, Session } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { useScheduleRuns } from '@/use-query/schedules/use-schedule-runs';
import { useCreateSchedule } from '@/use-query/schedules/use-create-schedule';
import { useDeleteSchedule } from '@/use-query/schedules/use-delete-schedule';
import { useRunScheduleNow } from '@/use-query/schedules/use-run-schedule-now';
import { useUpdateSchedule } from '@/use-query/schedules/use-update-schedule';
import { useSchedules } from '@/use-query/schedules/use-schedules';
import { ScheduleForm } from './schedule-form';
import { ScheduleHistory } from './schedule-history';
import './schedules.css';

function statusBadgeVariant(status: ScheduledTask['status']) {
  if (status === 'active') return 'default' as const;
  if (status === 'paused') return 'secondary' as const;
  return 'outline' as const;
}

export default function SchedulesPage({
  projects,
  sessions,
  projectId,
  onOpenSession,
}: {
  projects: readonly Project[];
  sessions: readonly Session[];
  projectId?: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t, locale } = useUiTranslation('schedules');
  const [filterProjectId, setFilterProjectId] = useState<string>(projectId ?? '');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'rules' | 'history'>('rules');

  const schedulesQuery = useSchedules(filterProjectId || undefined);
  const tasks = schedulesQuery.data ?? [];

  const activeTask = useMemo(
    () => (creating ? undefined : (tasks.find((item) => item.id === selectedId) ?? tasks[0])),
    [creating, selectedId, tasks],
  );
  const runsQuery = useScheduleRuns(activeTask?.id);

  const createMutation = useCreateSchedule();
  const updateMutation = useUpdateSchedule();
  const deleteMutation = useDeleteSchedule();
  const runNowMutation = useRunScheduleNow();

  const projectNames = useMemo(
    () => new Map(projects.map((item) => [item.id, item.name])),
    [projects],
  );

  const formatDateTime = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));

  const mutationError =
    createMutation.error?.message ??
    updateMutation.error?.message ??
    deleteMutation.error?.message ??
    runNowMutation.error?.message;

  return (
    <div className="schedules-page">
      <header className="schedules-header">
        <div>
          <h1 className="schedules-title">{t('title')}</h1>
          <p className="schedules-subtitle">{t('subtitle')}</p>
        </div>
        <div className="schedules-header-actions">
          <select
            className="schedules-input schedules-filter"
            aria-label={t('fields.project')}
            value={filterProjectId}
            onChange={(e) => setFilterProjectId(e.target.value)}
          >
            <option value="">{t('meta.allProjects')}</option>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <Button
            type="button"
            onClick={() => {
              setCreating(true);
              setTab('rules');
            }}
            disabled={projects.length === 0}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('newTask')}
          </Button>
        </div>
      </header>

      <div className="schedules-layout">
        <aside className="schedules-list-pane" aria-label={t('title')}>
          {tasks.length === 0 && !schedulesQuery.isLoading ? (
            <div className="schedules-empty">
              <Clock className="size-6" aria-hidden="true" />
              <h2>{t('emptyTitle')}</h2>
              <p>{t('emptyDescription')}</p>
            </div>
          ) : (
            <ul className="schedules-task-list">
              {tasks.map((task) => {
                const selected = !creating && activeTask?.id === task.id;
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      className={
                        selected
                          ? 'schedules-task-row schedules-task-row-active'
                          : 'schedules-task-row'
                      }
                      onClick={() => {
                        setCreating(false);
                        setSelectedId(task.id);
                      }}
                    >
                      <div className="schedules-task-row-top">
                        <span className="schedules-task-name">{task.title}</span>
                        <Badge variant={statusBadgeVariant(task.status)}>
                          {t(`status.${task.status}`)}
                        </Badge>
                      </div>
                      <div className="schedules-task-row-meta">
                        <span>{projectNames.get(task.projectId) ?? task.projectId}</span>
                        <span>
                          {task.nextRunAt
                            ? t('meta.nextRun', { time: formatDateTime(task.nextRunAt) })
                            : t('meta.noNextRun')}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <section className="schedules-detail-pane">
          {creating ? (
            <div className="schedules-detail-body">
              <h2 className="schedules-detail-title">{t('newTask')}</h2>
              <ScheduleForm
                mode="create"
                projects={projects}
                sessions={sessions}
                defaultProjectId={filterProjectId || projectId || projects[0]?.id}
                pending={createMutation.isPending}
                error={createMutation.error?.message}
                onCancel={() => setCreating(false)}
                onCreate={(input) => {
                  createMutation.mutate(input, {
                    onSuccess: (created) => {
                      setCreating(false);
                      setSelectedId(created.id);
                      setTab('rules');
                    },
                  });
                }}
              />
            </div>
          ) : activeTask ? (
            <div className="schedules-detail-body">
              <div className="schedules-detail-head">
                <div>
                  <h2 className="schedules-detail-title">{activeTask.title}</h2>
                  <p className="schedules-muted">
                    {activeTask.nextRunAt
                      ? t('meta.nextRun', { time: formatDateTime(activeTask.nextRunAt) })
                      : t('meta.noNextRun')}
                  </p>
                </div>
                <div className="schedules-detail-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={runNowMutation.isPending}
                    onClick={() => runNowMutation.mutate(activeTask.id)}
                  >
                    <Zap className="size-3.5" aria-hidden="true" />
                    {t('actions.runNow')}
                  </Button>
                  {activeTask.status === 'active' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={updateMutation.isPending}
                      onClick={() =>
                        updateMutation.mutate({
                          id: activeTask.id,
                          patch: { expectedUpdatedAt: activeTask.updatedAt, status: 'paused' },
                        })
                      }
                    >
                      <Pause className="size-3.5" aria-hidden="true" />
                      {t('actions.pause')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={updateMutation.isPending}
                      onClick={() =>
                        updateMutation.mutate({
                          id: activeTask.id,
                          patch: { expectedUpdatedAt: activeTask.updatedAt, status: 'active' },
                        })
                      }
                    >
                      <Play className="size-3.5" aria-hidden="true" />
                      {t('actions.resume')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      deleteMutation.mutate(activeTask.id, {
                        onSuccess: () => setSelectedId(undefined),
                      });
                    }}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    {t('actions.delete')}
                  </Button>
                </div>
              </div>

              <div className="schedules-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'rules'}
                  className={
                    tab === 'rules' ? 'schedules-tab schedules-tab-active' : 'schedules-tab'
                  }
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
                <ScheduleForm
                  mode="edit"
                  task={activeTask}
                  projects={projects}
                  sessions={sessions}
                  pending={updateMutation.isPending}
                  error={mutationError}
                  onUpdate={(id, patch) => updateMutation.mutate({ id, patch })}
                />
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
                    {t('actions.openSession')}
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="schedules-empty">
              <p>{t('meta.selectPrompt')}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
