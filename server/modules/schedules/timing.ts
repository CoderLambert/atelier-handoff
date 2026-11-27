/**
 * @file 计算与校验定时任务的下一次触发时刻。
 * @implementation 基于 croner 进行标准 5 段 Cron 与 IANA 时区算术，保留五种权威调度规则并处理夏令时跳变。
 * @updated 2026-11-27T13:08:00+08:00
 */
import { Cron } from 'croner';
import { AppError } from '../../../shared/errors.js';
import {
  SCHEDULE_MIN_NEW_SESSION_INTERVAL_SECONDS,
  type ScheduleTargetMode,
  type ScheduleTiming,
} from '../../../shared/schedules.js';

export function resolveSystemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function validateTimeZone(timeZone: string): string {
  const trimmed = timeZone.trim();
  if (!trimmed) throw new AppError('SCHEDULE_INVALID_TIMING', '时区不能为空。', 400);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw new AppError('SCHEDULE_INVALID_TIMING', `无效的 IANA 时区：${trimmed}`, 400);
  }
  return trimmed;
}

function parseTimeParts(time: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new AppError('SCHEDULE_INVALID_TIMING', '时间格式必须为 HH:mm。', 400);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function validateFiveFieldCron(expression: string, timeZone: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new AppError(
      'SCHEDULE_INVALID_TIMING',
      'Cron 表达式必须为标准 5 段格式（分 时 日 月 周）。',
      400,
    );
  try {
    return new Cron(fields.join(' '), { timezone: timeZone, paused: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '格式无效';
    throw new AppError('SCHEDULE_INVALID_TIMING', `Cron 表达式无效：${detail}`, 400);
  }
}

export function normalizeTiming(
  timing: ScheduleTiming,
  timeZone: string,
  targetMode: ScheduleTargetMode,
  nowDate: Date,
): ScheduleTiming {
  validateTimeZone(timeZone);
  switch (timing.kind) {
    case 'once': {
      const target = new Date(timing.runAt);
      if (Number.isNaN(target.getTime()))
        throw new AppError('SCHEDULE_INVALID_TIMING', '一次性任务的执行时间无效。', 400);
      return { kind: 'once', runAt: target.toISOString() };
    }
    case 'interval': {
      const minSeconds = targetMode === 'new' ? SCHEDULE_MIN_NEW_SESSION_INTERVAL_SECONDS : 60;
      if (timing.everySeconds < minSeconds) {
        throw new AppError(
          'SCHEDULE_INVALID_TIMING',
          targetMode === 'new'
            ? `每次新建独立会话的定时任务最小间隔为 ${minSeconds} 秒。`
            : '固定间隔任务最小间隔为 60 秒。',
          400,
        );
      }
      const anchor = timing.anchorAt ? new Date(timing.anchorAt) : nowDate;
      if (Number.isNaN(anchor.getTime()))
        throw new AppError('SCHEDULE_INVALID_TIMING', '固定间隔任务的锚点时间无效。', 400);
      return {
        kind: 'interval',
        everySeconds: timing.everySeconds,
        anchorAt: anchor.toISOString(),
      };
    }
    case 'daily': {
      parseTimeParts(timing.time);
      return {
        kind: 'daily',
        time: timing.time,
        everyDays: timing.everyDays,
      };
    }
    case 'weekly': {
      parseTimeParts(timing.time);
      const sorted = [...timing.weekdays].sort((a, b) => a - b);
      return {
        kind: 'weekly',
        time: timing.time,
        weekdays: sorted,
      };
    }
    case 'cron': {
      const normalized = timing.expression.trim().replace(/\s+/g, ' ');
      const job = validateFiveFieldCron(normalized, timeZone);
      const next = job.nextRun(nowDate);
      if (!next)
        throw new AppError('SCHEDULE_INVALID_TIMING', '该 Cron 规则没有可触发的未来时间。', 400);
      if (targetMode === 'new') {
        const second = job.nextRun(next);
        if (
          second &&
          second.getTime() - next.getTime() < SCHEDULE_MIN_NEW_SESSION_INTERVAL_SECONDS * 1000
        ) {
          throw new AppError(
            'SCHEDULE_INVALID_TIMING',
            `每次新建独立会话的定时任务最小触发间隔为 ${SCHEDULE_MIN_NEW_SESSION_INTERVAL_SECONDS} 秒。`,
            400,
          );
        }
      }
      return { kind: 'cron', expression: normalized };
    }
  }
}

export function computeNextRunAt(
  timing: ScheduleTiming,
  timeZone: string,
  after: Date,
  options?: { lastRunAt?: string | null },
): string | null {
  switch (timing.kind) {
    case 'once': {
      const target = new Date(timing.runAt);
      return target.getTime() > after.getTime() ? target.toISOString() : null;
    }
    case 'interval': {
      const stepMs = timing.everySeconds * 1000;
      const anchorMs = new Date(timing.anchorAt ?? after.toISOString()).getTime();
      const afterMs = after.getTime();
      if (anchorMs > afterMs) return new Date(anchorMs).toISOString();
      const steps = Math.floor((afterMs - anchorMs) / stepMs) + 1;
      return new Date(anchorMs + steps * stepMs).toISOString();
    }
    case 'daily': {
      const { hour, minute } = parseTimeParts(timing.time);
      const job = new Cron(`${minute} ${hour} * * *`, { timezone: timeZone, paused: true });
      if (timing.everyDays <= 1) {
        const next = job.nextRun(after);
        return next ? next.toISOString() : null;
      }
      // Step daily occurrences in target timezone so multi-day intervals respect local wall time.
      const base = options?.lastRunAt ? new Date(options.lastRunAt) : after;
      let candidate = job.nextRun(base);
      for (let skipped = 1; candidate && skipped < timing.everyDays; skipped++) {
        candidate = job.nextRun(candidate);
      }
      while (candidate && candidate.getTime() <= after.getTime()) {
        for (let step = 0; candidate && step < timing.everyDays; step++) {
          candidate = job.nextRun(candidate);
        }
      }
      return candidate ? candidate.toISOString() : null;
    }
    case 'weekly': {
      const { hour, minute } = parseTimeParts(timing.time);
      const cronDays = timing.weekdays.map((day) => (day === 7 ? 0 : day)).join(',');
      const job = new Cron(`${minute} ${hour} * * ${cronDays}`, {
        timezone: timeZone,
        paused: true,
      });
      const next = job.nextRun(after);
      return next ? next.toISOString() : null;
    }
    case 'cron': {
      const job = validateFiveFieldCron(timing.expression, timeZone);
      const next = job.nextRun(after);
      return next ? next.toISOString() : null;
    }
  }
}

export function timingEquals(a: ScheduleTiming, b: ScheduleTiming): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'once':
      return b.kind === 'once' && a.runAt === b.runAt;
    case 'interval':
      return b.kind === 'interval' && a.everySeconds === b.everySeconds;
    case 'daily':
      return b.kind === 'daily' && a.time === b.time && a.everyDays === b.everyDays;
    case 'weekly':
      return (
        b.kind === 'weekly' &&
        a.time === b.time &&
        a.weekdays.length === b.weekdays.length &&
        a.weekdays.every((day, index) => day === b.weekdays[index])
      );
    case 'cron':
      return b.kind === 'cron' && a.expression === b.expression;
  }
}
