/**
 * @file 提供定时任务规则的新建与编辑表单组件。
 * @implementation 支持五种权威调度类型、执行落点、权限与自动审批护栏、错失/重叠与通知策略，遵循类型化双语文案。
 * @updated 2026-11-27T13:30:00+08:00
 */
import { useEffect, useState, type FormEvent } from 'react';
import type {
  CreateScheduledTaskInput,
  Project,
  ScheduledTask,
  ScheduleMisfirePolicy,
  ScheduleNotifyPolicy,
  ScheduleOverlapPolicy,
  ScheduleTargetMode,
  ScheduleTiming,
  Session,
  UpdateScheduledTaskInput,
} from '@shared/types';
import { Button } from '@/components/ui/button';
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

  useEffect(() => {
    if (!task) return;
    setProjectId(task.projectId);
    setTitle(task.title);
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
    setAutomaticApproval(task.approvalMode === 'automatic');
    setMisfirePolicy(task.misfirePolicy);
    setOverlapPolicy(task.overlapPolicy);
    setNotifyPolicy(task.notifyPolicy);
  }, [task]);

  const projectSessions = sessions.filter(
    (item) => item.projectId === projectId && item.status === 'active',
  );

  function buildTiming(): ScheduleTiming {
    switch (timingKind) {
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
    const approvalMode = permissionMode === 'edit' && automaticApproval ? 'automatic' : null;
    if (mode === 'create' && onCreate) {
      onCreate({
        projectId,
        title: title.trim(),
        prompt: prompt.trim(),
        timing,
        timeZone: timeZone.trim() || defaultTimeZone(),
        targetMode,
        targetSessionId: targetMode === 'session' ? targetSessionId || null : null,
        mode: permissionMode,
        approvalMode,
        maxSearchChargeFen: 0,
        misfirePolicy,
        overlapPolicy,
        notifyPolicy,
      });
    } else if (mode === 'edit' && task && onUpdate) {
      onUpdate(task.id, {
        expectedUpdatedAt: task.updatedAt,
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

  return (
    <form className="schedules-form" onSubmit={handleSubmit}>
      {error ? (
        <div className="schedules-error" role="alert">
          {error}
        </div>
      ) : null}

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
        <label className="schedules-field">
          <span className="schedules-label">{t('fields.project')}</span>
          <select
            className="schedules-input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          >
            {projects.map((proj) => (
              <option key={proj.id} value={proj.id}>
                {proj.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="schedules-field">
        <span className="schedules-label">{t('fields.prompt')}</span>
        <textarea
          className="schedules-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t('fields.promptPlaceholder')}
          rows={5}
          required
        />
      </label>

      <div className="schedules-grid-2">
        <label className="schedules-field">
          <span className="schedules-label">{t('fields.targetMode')}</span>
          <select
            className="schedules-input"
            value={targetMode}
            onChange={(e) => setTargetMode(e.target.value as ScheduleTargetMode)}
          >
            <option value="new_once">{t('target.newOnce')}</option>
            <option value="session">{t('target.session')}</option>
            <option value="new">{t('target.new')}</option>
          </select>
        </label>

        {targetMode === 'session' ? (
          <label className="schedules-field">
            <span className="schedules-label">{t('target.session')}</span>
            <select
              className="schedules-input"
              value={targetSessionId}
              onChange={(e) => setTargetSessionId(e.target.value)}
              required
            >
              <option value="">—</option>
              {projectSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="schedules-grid-2">
        <label className="schedules-field">
          <span className="schedules-label">{t('fields.timingKind')}</span>
          <select
            className="schedules-input"
            value={timingKind}
            onChange={(e) => setTimingKind(e.target.value as ScheduleTiming['kind'])}
          >
            <option value="daily">{t('timing.daily')}</option>
            <option value="weekly">{t('timing.weekly')}</option>
            <option value="interval">{t('timing.interval')}</option>
            <option value="once">{t('timing.once')}</option>
            <option value="cron">{t('timing.cron')}</option>
          </select>
        </label>

        <label className="schedules-field">
          <span className="schedules-label">{t('fields.timeZone')}</span>
          <input
            type="text"
            className="schedules-input"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            required
          />
        </label>
      </div>

      {timingKind === 'daily' ? (
        <div className="schedules-grid-2">
          <label className="schedules-field">
            <span className="schedules-label">{t('fields.time')}</span>
            <input
              type="time"
              className="schedules-input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
            />
          </label>
          <label className="schedules-field">
            <span className="schedules-label">{t('fields.everyDays')}</span>
            <input
              type="number"
              className="schedules-input"
              min={1}
              max={365}
              value={everyDays}
              onChange={(e) => setEveryDays(Number(e.target.value) || 1)}
            />
          </label>
        </div>
      ) : null}

      {timingKind === 'weekly' ? (
        <div className="schedules-field">
          <label className="schedules-field">
            <span className="schedules-label">{t('fields.time')}</span>
            <input
              type="time"
              className="schedules-input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
            />
          </label>
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
      ) : null}

      {timingKind === 'interval' ? (
        <label className="schedules-field">
          <span className="schedules-label">{t('fields.everyMinutes')}</span>
          <input
            type="number"
            className="schedules-input"
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
            className="schedules-input"
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

      <div className="schedules-grid-2">
        <label className="schedules-field">
          <span className="schedules-label">{t('fields.mode')}</span>
          <select
            className="schedules-input"
            value={permissionMode}
            onChange={(e) => {
              const next = e.target.value as 'readonly' | 'edit';
              setPermissionMode(next);
              if (next === 'readonly') setAutomaticApproval(false);
            }}
          >
            <option value="readonly">{t('mode.readonly')}</option>
            <option value="edit">{t('mode.edit')}</option>
          </select>
        </label>

        <label className="schedules-field">
          <span className="schedules-label">{t('fields.approval')}</span>
          <select
            className="schedules-input"
            value={automaticApproval ? 'automatic' : 'manual'}
            disabled={permissionMode !== 'edit'}
            onChange={(e) => setAutomaticApproval(e.target.value === 'automatic')}
          >
            <option value="manual">{t('approval.manual')}</option>
            <option value="automatic">{t('approval.automatic')}</option>
          </select>
        </label>
      </div>

      <div className="schedules-grid-3">
        <label className="schedules-field">
          <span className="schedules-label">{t('fields.misfire')}</span>
          <select
            className="schedules-input"
            value={misfirePolicy}
            onChange={(e) => setMisfirePolicy(e.target.value as ScheduleMisfirePolicy)}
          >
            <option value="run_once">{t('misfire.runOnce')}</option>
            <option value="skip">{t('misfire.skip')}</option>
          </select>
        </label>

        <label className="schedules-field">
          <span className="schedules-label">{t('fields.overlap')}</span>
          <select
            className="schedules-input"
            value={overlapPolicy}
            onChange={(e) => setOverlapPolicy(e.target.value as ScheduleOverlapPolicy)}
          >
            <option value="skip">{t('overlap.skip')}</option>
            <option value="queue">{t('overlap.queue')}</option>
          </select>
        </label>

        <label className="schedules-field">
          <span className="schedules-label">{t('fields.notify')}</span>
          <select
            className="schedules-input"
            value={notifyPolicy}
            onChange={(e) => setNotifyPolicy(e.target.value as ScheduleNotifyPolicy)}
          >
            <option value="on_error">{t('notify.onError')}</option>
            <option value="always">{t('notify.always')}</option>
            <option value="on_attention">{t('notify.onAttention')}</option>
            <option value="never">{t('notify.never')}</option>
          </select>
        </label>
      </div>

      <div className="schedules-form-actions">
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            {t('actions.cancel')}
          </Button>
        ) : null}
        <Button type="submit" disabled={pending || !title.trim() || !prompt.trim() || !projectId}>
          {mode === 'create' ? t('actions.create') : t('actions.save')}
        </Button>
      </div>
    </form>
  );
}
