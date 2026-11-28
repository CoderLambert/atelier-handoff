/**
 * @file 提供定时任务规则的新建与编辑表单组件。
 * @implementation 采用 Atelier 原生 Radix Select 与分组表单布局，支持五种调度类型、执行落点与可折叠权限策略。
 * @updated 2026-11-27T23:59:00+08:00
 */
import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import type {
  CreateScheduledTaskInput,
  Project,
  ScheduledTask,
  ScheduleExecutionPreference,
  ScheduleMisfirePolicy,
  ScheduleNotifyPolicy,
  ScheduleOverlapPolicy,
  ScheduleTargetMode,
  ScheduleTiming,
  Session,
  UpdateScheduledTaskInput,
} from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUiTranslation } from '@/i18n';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ScheduleForm({
  mode,
  task,
  projects,
  sessions,
  defaultProjectId,
  nativeExecution = false,
  pending,
  error,
  onCreate,
  onUpdate,
  onCancel,
}: {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  projects: readonly Project[];
  sessions: readonly Session[];
  defaultProjectId?: string;
  nativeExecution?: boolean;
  pending: boolean;
  error?: string;
  onCreate?: (input: CreateScheduledTaskInput) => void;
  onUpdate?: (id: string, patch: UpdateScheduledTaskInput) => void;
  onCancel?: () => void;
}) {
  const { t } = useUiTranslation('schedules');
  const [projectId, setProjectId] = useState(
    task?.projectId ?? defaultProjectId ?? projects[0]?.id ?? '',
  );
  const [title, setTitle] = useState(task?.title ?? '');
  const [slug, setSlug] = useState(task?.slug ?? '');
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [targetMode, setTargetMode] = useState<ScheduleTargetMode>(task?.targetMode ?? 'new_once');
  const [targetSessionId, setTargetSessionId] = useState(task?.targetSessionId ?? '');
  const [timingKind, setTimingKind] = useState<ScheduleTiming['kind']>(
    task?.timing.kind ?? 'daily',
  );
  const [time, setTime] = useState(
    task?.timing.kind === 'daily' || task?.timing.kind === 'weekly' ? task.timing.time : '09:00',
  );
  const [everyDays, setEveryDays] = useState(
    task?.timing.kind === 'daily' ? task.timing.everyDays : 1,
  );
  const [weekdays, setWeekdays] = useState<number[]>(
    task?.timing.kind === 'weekly' ? [...task.timing.weekdays] : [1, 2, 3, 4, 5],
  );
  const [everyMinutes, setEveryMinutes] = useState(
    task?.timing.kind === 'interval' ? Math.max(1, Math.round(task.timing.everySeconds / 60)) : 30,
  );
  const [runAtLocal, setRunAtLocal] = useState(
    task?.timing.kind === 'once'
      ? toLocalDateTimeInput(task.timing.runAt)
      : toLocalDateTimeInput(new Date(Date.now() + 3_600_000).toISOString()),
  );
  const [cronExpression, setCronExpression] = useState(
    task?.timing.kind === 'cron' ? task.timing.expression : '0 9 * * 1-5',
  );
  const [timeZone, setTimeZone] = useState(task?.timeZone ?? defaultTimeZone());
  const [permissionMode, setPermissionMode] = useState<'readonly' | 'edit'>(
    task?.mode ?? 'readonly',
  );
  const [executionPreference, setExecutionPreference] = useState<ScheduleExecutionPreference>(
    task?.executionPreference ?? 'project-v1',
  );
  const [automaticApproval, setAutomaticApproval] = useState(task?.approvalMode === 'automatic');
  const [misfirePolicy, setMisfirePolicy] = useState<ScheduleMisfirePolicy>(
    task?.misfirePolicy ?? 'run_once',
  );
  const [overlapPolicy, setOverlapPolicy] = useState<ScheduleOverlapPolicy>(
    task?.overlapPolicy ?? 'skip',
  );
  const [notifyPolicy, setNotifyPolicy] = useState<ScheduleNotifyPolicy>(
    task?.notifyPolicy ?? 'on_error',
  );
  const [advancedOpen, setAdvancedOpen] = useState(
    task?.mode === 'edit' || task?.executionPreference === 'native-v1',
  );

  useEffect(() => {
    if (mode === 'create' && defaultProjectId) setProjectId(defaultProjectId);
  }, [mode, defaultProjectId]);

  useEffect(() => {
    if (!task) return;
    setProjectId(task.projectId);
    setTitle(task.title);
    setSlug(task.slug ?? '');
    setPrompt(task.prompt);
    setTargetMode(task.targetMode);
    setTargetSessionId(task.targetSessionId ?? '');
    setTimingKind(task.timing.kind);
    if (task.timing.kind === 'daily') {
      setTime(task.timing.time);
      setEveryDays(task.timing.everyDays);
    } else if (task.timing.kind === 'weekly') {
      setTime(task.timing.time);
      setWeekdays([...task.timing.weekdays]);
    } else if (task.timing.kind === 'interval') {
      setEveryMinutes(Math.max(1, Math.round(task.timing.everySeconds / 60)));
    } else if (task.timing.kind === 'once') {
      setRunAtLocal(toLocalDateTimeInput(task.timing.runAt));
    } else if (task.timing.kind === 'cron') {
      setCronExpression(task.timing.expression);
    }
    setTimeZone(task.timeZone);
    setPermissionMode(task.mode);
    setExecutionPreference(task.executionPreference);
    setAutomaticApproval(task.approvalMode === 'automatic');
    setMisfirePolicy(task.misfirePolicy);
    setOverlapPolicy(task.overlapPolicy);
    setNotifyPolicy(task.notifyPolicy);
    setAdvancedOpen(task.mode === 'edit' || task.executionPreference === 'native-v1');
  }, [task]);

  const projectSessions = sessions.filter(
    (item) => item.projectId === projectId && item.status === 'active',
  );

  function buildTiming(): ScheduleTiming {
    switch (timingKind) {
      case 'manual':
        return { kind: 'manual' };
      case 'once':
        return { kind: 'once', runAt: new Date(runAtLocal).toISOString() };
      case 'interval':
        return { kind: 'interval', everySeconds: Math.max(1, everyMinutes) * 60 };
      case 'daily':
        return { kind: 'daily', time, everyDays: Math.max(1, everyDays) };
      case 'weekly':
        return {
          kind: 'weekly',
          time,
          weekdays: weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b) : [1],
        };
      case 'cron':
        return { kind: 'cron', expression: cronExpression.trim() };
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const timing = buildTiming();
    const effectiveExecution: ScheduleExecutionPreference =
      permissionMode === 'edit' ? executionPreference : 'project-v1';
    const approvalMode =
      permissionMode === 'edit' && effectiveExecution === 'project-v1' && automaticApproval
        ? 'automatic'
        : null;
    const normalizedSlug = slug.trim() || null;
    if (mode === 'create' && onCreate) {
      onCreate({
        projectId,
        ...(normalizedSlug ? { slug: normalizedSlug } : {}),
        title: title.trim(),
        prompt: prompt.trim(),
        timing,
        timeZone: timeZone.trim() || defaultTimeZone(),
        targetMode,
        targetSessionId: targetMode === 'session' ? targetSessionId || null : null,
        mode: permissionMode,
        executionPreference: effectiveExecution,
        approvalMode,
        maxSearchChargeFen: 0,
        misfirePolicy,
        overlapPolicy,
        notifyPolicy,
      });
    } else if (mode === 'edit' && task && onUpdate) {
      onUpdate(task.id, {
        expectedUpdatedAt: task.updatedAt,
        slug: normalizedSlug,
        title: title.trim(),
        prompt: prompt.trim(),
        timing,
        timeZone: timeZone.trim() || defaultTimeZone(),
        targetMode,
        targetSessionId:
          targetMode === 'session'
            ? targetSessionId || null
            : targetMode === 'new'
              ? null
              : task.targetSessionId,
        mode: permissionMode,
        executionPreference: effectiveExecution,
        approvalMode,
        misfirePolicy,
        overlapPolicy,
        notifyPolicy,
      });
    }
  }

  function toggleWeekday(day: number) {
    setWeekdays((prev) =>
      prev.includes(day)
        ? prev.length > 1
          ? prev.filter((item) => item !== day)
          : prev
        : [...prev, day].sort((a, b) => a - b),
    );
  }

  const notifyLabel =
    notifyPolicy === 'always'
      ? t('notify.always')
      : notifyPolicy === 'on_attention'
        ? t('notify.onAttention')
        : notifyPolicy === 'never'
          ? t('notify.never')
          : t('notify.onError');

  const modeLabel =
    permissionMode === 'edit' && executionPreference === 'native-v1'
      ? t('mode.native')
      : permissionMode === 'edit'
        ? t('mode.edit')
        : t('mode.readonly');
  const advancedSummary = `${modeLabel} · ${notifyLabel}`;

  return (
    <form className="schedules-form" onSubmit={handleSubmit}>
      {error ? (
        <div className="schedules-error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <div className="schedules-section">
        <div className={mode === 'create' ? 'schedules-row-title-project' : undefined}>
          <label className="schedules-field">
            <span className="schedules-label">{t('fields.title')}</span>
            <input
              type="text"
              className="schedules-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('fields.titlePlaceholder')}
              required
              maxLength={160}
            />
          </label>

          {mode === 'create' ? (
            <div className="schedules-field">
              <span className="schedules-label">{t('fields.project')}</span>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="w-full" aria-label={t('fields.project')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {projects.map((proj) => (
                    <SelectItem key={proj.id} value={proj.id}>
                      {proj.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <label className="schedules-field">
          <span className="schedules-label">{t('fields.prompt')}</span>
          <textarea
            className="schedules-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('fields.promptPlaceholder')}
            rows={4}
            required
          />
        </label>

        <div className={targetMode === 'session' ? 'schedules-grid-2' : undefined}>
          <div className="schedules-field">
            <span className="schedules-label">{t('fields.targetMode')}</span>
            <Select
              value={targetMode}
              onValueChange={(value) => setTargetMode(value as ScheduleTargetMode)}
            >
              <SelectTrigger className="w-full" aria-label={t('fields.targetMode')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="new_once">{t('target.newOnce')}</SelectItem>
                <SelectItem value="session">{t('target.session')}</SelectItem>
                <SelectItem value="new">{t('target.new')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {targetMode === 'session' ? (
            <div className="schedules-field">
              <span className="schedules-label">{t('target.session')}</span>
              <Select value={targetSessionId} onValueChange={setTargetSessionId}>
                <SelectTrigger className="w-full" aria-label={t('target.session')}>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {projectSessions.map((session) => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      </div>

      <fieldset className="schedules-section-card">
        <legend className="schedules-section-heading">{t('sections.schedule')}</legend>

        <div className={timingKind === 'manual' ? undefined : 'schedules-grid-2'}>
          <div className="schedules-field">
            <span className="schedules-label">{t('fields.timingKind')}</span>
            <Select
              value={timingKind}
              onValueChange={(value) => setTimingKind(value as ScheduleTiming['kind'])}
            >
              <SelectTrigger className="w-full" aria-label={t('fields.timingKind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value="manual">{t('timing.manual')}</SelectItem>
                <SelectItem value="daily">{t('timing.daily')}</SelectItem>
                <SelectItem value="weekly">{t('timing.weekly')}</SelectItem>
                <SelectItem value="interval">{t('timing.interval')}</SelectItem>
                <SelectItem value="once">{t('timing.once')}</SelectItem>
                <SelectItem value="cron">{t('timing.cron')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {timingKind !== 'manual' ? (
            <label className="schedules-field">
              <span className="schedules-label">{t('fields.timeZone')}</span>
              <input
                type="text"
                className="schedules-input schedules-mono"
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                required
              />
            </label>
          ) : null}
        </div>

        {timingKind === 'daily' ? (
          <div className="schedules-grid-2">
            <label className="schedules-field">
              <span className="schedules-label">{t('fields.time')}</span>
              <input
                type="time"
                className="schedules-input schedules-mono"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </label>
            <label className="schedules-field">
              <span className="schedules-label">{t('fields.everyDays')}</span>
              <input
                type="number"
                className="schedules-input schedules-mono"
                min={1}
                max={365}
                value={everyDays}
                onChange={(e) => setEveryDays(Number(e.target.value) || 1)}
              />
            </label>
          </div>
        ) : null}

        {timingKind === 'weekly' ? (
          <div className="schedules-weekly-group">
            <label className="schedules-field">
              <span className="schedules-label">{t('fields.time')}</span>
              <input
                type="time"
                className="schedules-input schedules-mono"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </label>
            <div className="schedules-field">
              <span className="schedules-label">{t('fields.weekdays')}</span>
              <div className="schedules-weekdays">
                {WEEKDAYS.map((day) => {
                  const active = weekdays.includes(day);
                  return (
                    <button
                      key={day}
                      type="button"
                      className={active ? 'schedules-day schedules-day-active' : 'schedules-day'}
                      onClick={() => toggleWeekday(day)}
                      aria-pressed={active}
                    >
                      {t(`weekday.${day}`)}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {timingKind === 'interval' ? (
          <label className="schedules-field">
            <span className="schedules-label">{t('fields.everyMinutes')}</span>
            <input
              type="number"
              className="schedules-input schedules-mono"
              min={targetMode === 'new' ? 5 : 1}
              max={525_600}
              value={everyMinutes}
              onChange={(e) => setEveryMinutes(Number(e.target.value) || 1)}
              required
            />
          </label>
        ) : null}

        {timingKind === 'once' ? (
          <label className="schedules-field">
            <span className="schedules-label">{t('fields.runAt')}</span>
            <input
              type="datetime-local"
              className="schedules-input schedules-mono"
              value={runAtLocal}
              onChange={(e) => setRunAtLocal(e.target.value)}
              required
            />
          </label>
        ) : null}

        {timingKind === 'cron' ? (
          <label className="schedules-field">
            <span className="schedules-label">{t('fields.cron')}</span>
            <input
              type="text"
              className="schedules-input schedules-mono"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="0 9 * * 1-5"
              required
            />
          </label>
        ) : null}
      </fieldset>

      <div className="schedules-advanced-card">
        <button
          type="button"
          className="schedules-advanced-toggle"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          <span className="schedules-advanced-title">
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            <span>{t('sections.advanced')}</span>
          </span>
          <span className="schedules-advanced-summary">{advancedSummary}</span>
          <ChevronDown
            className={
              advancedOpen
                ? 'size-4 schedules-advanced-chevron schedules-advanced-chevron-open'
                : 'size-4 schedules-advanced-chevron'
            }
            aria-hidden="true"
          />
        </button>

        {advancedOpen ? (
          <div className="schedules-advanced-body">
            <label className="schedules-field">
              <span className="schedules-label">{t('fields.slug')}</span>
              <input
                type="text"
                className="schedules-input schedules-mono"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={t('fields.slugPlaceholder')}
                maxLength={64}
              />
            </label>
            <div className="schedules-grid-2">
              <div className="schedules-field">
                <span className="schedules-label">{t('fields.mode')}</span>
                <Select
                  value={
                    permissionMode === 'edit' && executionPreference === 'native-v1'
                      ? 'native'
                      : permissionMode
                  }
                  onValueChange={(value) => {
                    if (value === 'native') {
                      setPermissionMode('edit');
                      setExecutionPreference('native-v1');
                      setAutomaticApproval(false);
                    } else if (value === 'edit') {
                      setPermissionMode('edit');
                      setExecutionPreference('project-v1');
                    } else {
                      setPermissionMode('readonly');
                      setExecutionPreference('project-v1');
                      setAutomaticApproval(false);
                    }
                  }}
                >
                  <SelectTrigger className="w-full" aria-label={t('fields.mode')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value="readonly">{t('mode.readonly')}</SelectItem>
                    <SelectItem value="edit">{t('mode.edit')}</SelectItem>
                    {nativeExecution || executionPreference === 'native-v1' ? (
                      <SelectItem value="native">{t('mode.native')}</SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </div>

              <div className="schedules-field">
                <span className="schedules-label">{t('fields.approval')}</span>
                <Select
                  value={
                    executionPreference === 'native-v1'
                      ? 'nativeAuto'
                      : automaticApproval
                        ? 'automatic'
                        : 'manual'
                  }
                  disabled={permissionMode !== 'edit' || executionPreference === 'native-v1'}
                  onValueChange={(value) => setAutomaticApproval(value === 'automatic')}
                >
                  <SelectTrigger className="w-full" aria-label={t('fields.approval')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    {executionPreference === 'native-v1' ? (
                      <SelectItem value="nativeAuto">{t('approval.nativeAuto')}</SelectItem>
                    ) : (
                      <>
                        <SelectItem value="manual">{t('approval.manual')}</SelectItem>
                        <SelectItem value="automatic">{t('approval.automatic')}</SelectItem>
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="schedules-grid-3">
              <div className="schedules-field">
                <span className="schedules-label">{t('fields.misfire')}</span>
                <Select
                  value={misfirePolicy}
                  onValueChange={(value) => setMisfirePolicy(value as ScheduleMisfirePolicy)}
                >
                  <SelectTrigger className="w-full" aria-label={t('fields.misfire')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value="run_once">{t('misfire.runOnce')}</SelectItem>
                    <SelectItem value="skip">{t('misfire.skip')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="schedules-field">
                <span className="schedules-label">{t('fields.overlap')}</span>
                <Select
                  value={overlapPolicy}
                  onValueChange={(value) => setOverlapPolicy(value as ScheduleOverlapPolicy)}
                >
                  <SelectTrigger className="w-full" aria-label={t('fields.overlap')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value="skip">{t('overlap.skip')}</SelectItem>
                    <SelectItem value="queue">{t('overlap.queue')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="schedules-field">
                <span className="schedules-label">{t('fields.notify')}</span>
                <Select
                  value={notifyPolicy}
                  onValueChange={(value) => setNotifyPolicy(value as ScheduleNotifyPolicy)}
                >
                  <SelectTrigger className="w-full" aria-label={t('fields.notify')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value="on_error">{t('notify.onError')}</SelectItem>
                    <SelectItem value="always">{t('notify.always')}</SelectItem>
                    <SelectItem value="on_attention">{t('notify.onAttention')}</SelectItem>
                    <SelectItem value="never">{t('notify.never')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="schedules-form-actions">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            {t('actions.cancel')}
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={
            pending ||
            !title.trim() ||
            !prompt.trim() ||
            !projectId ||
            (targetMode === 'session' && !targetSessionId)
          }
        >
          {mode === 'create' ? t('actions.create') : t('actions.save')}
        </Button>
      </div>
    </form>
  );
}
