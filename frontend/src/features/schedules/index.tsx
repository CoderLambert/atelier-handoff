/**
 * @file 提供工作台自动化定时任务的全局管理页面。
 * @implementation 采用 Atelier 原生工作台双栏布局与 Radix Select 筛选，左侧展示任务清单与调度摘要，右侧提供规则编辑与运行记录双页签。
 * @updated 2026-11-27T23:59:00+08:00
 */
import { useMemo, useState } from 'react';
import { ArrowUpRight, Clock, Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import type { Project, ScheduledTask, Session } from '@shared/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUiTranslation } from '@/i18n';
import { useScheduleRuns } from '@/use-query/schedules/use-schedule-runs';
import { useCreateSchedule } from '@/use-query/schedules/use-create-schedule';
import { useDeleteSchedule } from '@/use-query/schedules/use-delete-schedule';
import { useRunScheduleNow } from '@/use-query/schedules/use-run-schedule-now';
import { useUpdateSchedule } from '@/use-query/schedules/use-update-schedule';
import { useSchedules } from '@/use-query/schedules/use-schedules';
import { useBootstrap } from '@/use-query/workspace/use-bootstrap';
import { formatScheduleSummary } from './schedule-card';
import { ScheduleForm } from './schedule-form';
import { ScheduleHistory } from './schedule-history';
import { ScheduleTriggerSection } from './schedule-trigger-section';
import './schedules.css';

const ALL_PROJECTS = '__all__';

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
  const [filterProjectId, setFilterProjectId] = useState<string>('');
  const bootstrap = useBootstrap();
  const nativeExecution = bootstrap.data?.capabilities.nativeExecution === true;
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

  const startCreating = () => {
    setCreating(true);
    setTab('rules');
  };

  return (
    <div className="schedules-page">
      <div className="schedules-page-inner">
        <header className="schedules-header">
          <div className="schedules-heading">
            <div className="schedules-heading-mark" aria-hidden="true">
              <Clock className="size-5" />
            </div>
            <div className="schedules-heading-copy">
              <h1 className="schedules-title">{t('title')}</h1>
              <p className="schedules-subtitle">{t('subtitle')}</p>
            </div>
          </div>

          <div className="schedules-header-actions">
            <Select
              value={filterProjectId || ALL_PROJECTS}
              onValueChange={(value) => setFilterProjectId(value === ALL_PROJECTS ? '' : value)}
            >
              <SelectTrigger className="w-44" aria-label={t('fields.project')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={ALL_PROJECTS}>{t('meta.allProjects')}</SelectItem>
                {projects.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              className="shrink-0"
              onClick={startCreating}
              disabled={projects.length === 0}
            >
              <Plus className="size-4" aria-hidden="true" />
              <span>{t('newTask')}</span>
            </Button>
          </div>
        </header>

        <div className="schedules-layout">
          <aside className="schedules-list-pane" aria-label={t('title')}>
            <div className="schedules-list-header">
              <span className="schedules-list-count">
                {t('meta.taskCount', { count: tasks.length })}
              </span>
            </div>

            {tasks.length === 0 && !schedulesQuery.isLoading ? (
              <EmptyState
                icon={<Clock />}
                title={t('emptyTitle')}
                description={t('emptyDescription')}
                className="border-0 bg-transparent px-4 py-10"
                action={
                  !creating && projects.length > 0 ? (
                    <Button type="button" variant="outline" size="sm" onClick={startCreating}>
                      <Plus className="size-3.5" aria-hidden="true" />
                      <span>{t('newTask')}</span>
                    </Button>
                  ) : null
                }
              />
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
                          <Badge variant={statusBadgeVariant(task.status)} className="shrink-0">
                            {t(`status.${task.status}`)}
                          </Badge>
                        </div>
                        <p className="schedules-task-summary">
                          {formatScheduleSummary(task, (key) => t(key as never))}
                        </p>
                        <div className="schedules-task-row-meta">
                          <span className="schedules-task-project">
                            {projectNames.get(task.projectId) ?? task.projectId}
                          </span>
                          <span className="schedules-task-next">
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
                <div className="schedules-detail-head">
                  <div>
                    <h2 className="schedules-detail-title">{t('newTask')}</h2>
                    <p className="schedules-muted">{t('subtitle')}</p>
                  </div>
                </div>
                <ScheduleForm
                  mode="create"
                  projects={projects}
                  sessions={sessions}
                  defaultProjectId={filterProjectId || projectId || projects[0]?.id}
                  nativeExecution={nativeExecution}
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
                  <div className="schedules-detail-heading">
                    <div className="schedules-detail-title-row">
                      <h2 className="schedules-detail-title">{activeTask.title}</h2>
                      <Badge variant={statusBadgeVariant(activeTask.status)} className="shrink-0">
                        {t(`status.${activeTask.status}`)}
                      </Badge>
                    </div>
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
                          onSuccess: () => setSelectedId(undefined),
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                      <span>{t('actions.delete')}</span>
                    </Button>
                  </div>
                </div>

                <Tabs
                  value={tab}
                  onValueChange={(value) => setTab(value as 'rules' | 'history')}
                  variant="underline"
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="rules">{t('tabs.rules')}</TabsTrigger>
                    <TabsTrigger value="history">{t('tabs.history')}</TabsTrigger>
                  </TabsList>
                </Tabs>

                {tab === 'rules' ? (
                  <>
                    <ScheduleForm
                      mode="edit"
                      task={activeTask}
                      projects={projects}
                      sessions={sessions}
                      nativeExecution={nativeExecution}
                      pending={updateMutation.isPending}
                      error={mutationError}
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
              </div>
            ) : (
              <div className="schedules-empty schedules-detail-empty">
                <div className="schedules-empty-icon" aria-hidden="true">
                  <Clock className="size-5" />
                </div>
                <p className="schedules-empty-copy">{t('meta.selectPrompt')}</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
