/**
 * @file 驱动定时任务到期触发、统一触发漏斗、防环护栏、并发公平与运行结果回写。
 * @implementation 维护单定时器加 60 秒漂移自检，所有触发入口统一收口到 trigger()，共用幂等去重、重叠保护、链路防环与槽位预留。
 * @updated 2026-11-27T15:05:00+08:00
 */
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors.js';
import {
  SCHEDULE_CONSECUTIVE_FAILURE_LIMIT,
  SCHEDULE_MAX_CHAIN_DEPTH,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduleNotifyPolicy,
  type ScheduleRunTriggerKind,
} from '../../../shared/schedules.js';
import { activeStatuses, type RunEvent, type Session } from '../../../shared/types.js';
import type { Store } from '../../store.js';
import type { StartRun } from '../runs/create-run.js';
import { computeNextRunAt } from './timing.js';

const MISFIRE_THRESHOLD_MS = 60_000;
const DRIFT_FALLBACK_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Reserve 1 of the 3 global execution slots for interactive user sessions.
const SCHEDULE_CONCURRENCY_CAP = 2;

export function shouldNotifyScheduledRun(
  policy: ScheduleNotifyPolicy,
  succeeded: boolean,
  assistantText?: string,
): boolean {
  switch (policy) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'on_error':
      return !succeeded;
    case 'on_attention':
      return !succeeded || /(?:^|\n)ATTENTION:/m.test(assistantText ?? '');
  }
}

function deterministicUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function composeEffectivePrompt(basePrompt: string, input?: string): string {
  const trimmed = input?.trim();
  if (!trimmed) return basePrompt;
  return `${basePrompt}\n\n---\n本次触发补充上下文：\n${trimmed}`;
}

export interface TriggerScheduleOptions {
  triggerKind: 'manual' | 'agent' | 'webhook';
  projectId?: string;
  input?: string;
  idempotencyKey?: string;
  triggerSource?: string;
  allowPaused?: boolean;
  chainDepth?: number;
  visitedTaskIds?: readonly string[];
}

export interface TriggerScheduleResult {
  run: ScheduledTaskRun;
  deduplicated: boolean;
}

export interface ScheduleSchedulerOptions {
  store: Pick<Store, 'get' | 'list' | 'update' | 'transaction' | 'event' | 'events' | 'repos'>;
  createSession(input: {
    projectId: string;
    agentRevisionId?: string;
    title?: string;
    origin?: 'schedule';
  }): Promise<Session>;
  createRun: StartRun;
  sameSessionRunning(sessionId: string): boolean;
  isShuttingDown(): boolean;
  clock?: () => Date;
  maxTimerMs?: number;
}

export function createScheduleScheduler({
  store,
  createSession,
  createRun,
  sameSessionRunning,
  isShuttingDown,
  clock = () => new Date(),
  maxTimerMs = DRIFT_FALLBACK_MS,
}: ScheduleSchedulerOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let runningTick: Promise<void> | undefined;
  let tickAgain = false;
  let started = false;

  function emitTaskEvent(
    task: Pick<ScheduledTask, 'id' | 'targetSessionId' | 'projectId'>,
    type: string,
  ) {
    const sessionId = task.targetSessionId ?? `schedule:${task.projectId}`;
    store.event(`schedule-${task.id}`, sessionId, type, {
      taskId: task.id,
      projectId: task.projectId,
    });
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function armTimer(): void {
    clearTimer();
    if (!started || isShuttingDown()) return;
    const next = store.repos.schedules.nextDue();
    const nowMs = clock().getTime();
    let delay = maxTimerMs;
    if (next?.nextRunAt) {
      const dueMs = new Date(next.nextRunAt).getTime();
      delay = Math.max(0, Math.min(dueMs - nowMs, maxTimerMs, MAX_TIMER_DELAY_MS));
    }
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, delay);
    timer.unref?.();
  }

  function advanceTaskAfterOccurrence(
    task: ScheduledTask,
    nowDate: Date,
    triggered: boolean,
  ): ScheduledTask {
    const nowIso = nowDate.toISOString();
    if (task.timing.kind === 'manual') {
      return {
        ...task,
        nextRunAt: null,
        lastRunAt: triggered ? nowIso : task.lastRunAt,
        updatedAt: nowIso,
      };
    }
    const nextRunAt =
      task.timing.kind === 'once'
        ? null
        : computeNextRunAt(task.timing, task.timeZone, nowDate, {
            lastRunAt: triggered ? nowIso : task.lastRunAt,
          });
    const nextStatus = task.timing.kind === 'once' || !nextRunAt ? 'ended' : task.status;
    return {
      ...task,
      status: nextStatus,
      nextRunAt,
      lastRunAt: triggered ? nowIso : task.lastRunAt,
      updatedAt: nowIso,
    };
  }

  async function resolveTargetSession(
    task: ScheduledTask,
    nowDate: Date,
  ): Promise<{ session: Session; updatedTask: ScheduledTask } | { skipReason: string }> {
    if (task.targetMode === 'session') {
      if (!task.targetSessionId) return { skipReason: 'target_missing' };
      try {
        const session = store.get('sessions', task.targetSessionId);
        if (session.status !== 'active') return { skipReason: 'target_archived' };
        return { session, updatedTask: task };
      } catch {
        return { skipReason: 'target_missing' };
      }
    }
    if (task.targetMode === 'new_once' && task.targetSessionId) {
      try {
        const session = store.get('sessions', task.targetSessionId);
        if (session.status !== 'active') return { skipReason: 'target_archived' };
        return { session, updatedTask: task };
      } catch {
        // Fall through to recreate a dedicated automation session if previous was deleted.
      }
    }
    const stamp = new Intl.DateTimeFormat('sv-SE', {
      timeZone: task.timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(nowDate);
    const title = task.targetMode === 'new' ? `${task.title} · ${stamp}` : task.title;
    const session = await createSession({
      projectId: task.projectId,
      ...(task.agentRevisionId ? { agentRevisionId: task.agentRevisionId } : {}),
      title,
      origin: 'schedule',
    });
    const updatedTask =
      task.targetMode === 'new_once' ? { ...task, targetSessionId: session.id } : task;
    return { session, updatedTask };
  }

  async function dispatchTask(
    task: ScheduledTask,
    triggerKind: ScheduleRunTriggerKind,
    scheduledFor: string,
    consumeSchedule: boolean,
    meta?: {
      input?: string;
      idempotencyKey?: string;
      triggerSource?: string;
      chainDepth?: number;
      visitedTaskIds?: readonly string[];
    },
  ): Promise<ScheduledTaskRun> {
    const nowDate = clock();
    const nowIso = nowDate.toISOString();
    const effectivePrompt = composeEffectivePrompt(task.prompt, meta?.input);
    const chainDepth = meta?.chainDepth ?? 0;
    const triggerSource = meta?.triggerSource ?? triggerKind;
    const externalKey = meta?.idempotencyKey ?? null;

    if (triggerKind === 'scheduled' || triggerKind === 'misfire') {
      const existing = store.repos.schedules.findRunByIdempotency(
        task.id,
        triggerKind,
        scheduledFor,
      );
      if (existing) return existing;
    }

    const resolved = await resolveTargetSession(task, nowDate);
    if ('skipReason' in resolved) {
      const record: ScheduledTaskRun = {
        id: randomUUID(),
        taskId: task.id,
        triggerKind,
        scheduledFor,
        targetSessionId: task.targetSessionId,
        runId: null,
        promptSnapshot: effectivePrompt,
        status: 'skipped',
        skipReason: resolved.skipReason,
        error: null,
        idempotencyKey: externalKey,
        triggerSource,
        chainDepth,
        createdAt: nowIso,
        finishedAt: nowIso,
      };
      store.transaction(() => {
        store.repos.schedules.insertRun(record);
        if (resolved.skipReason === 'target_archived' || resolved.skipReason === 'target_missing') {
          store.repos.schedules.update({
            ...task,
            status: 'paused',
            pauseReason: resolved.skipReason,
            updatedAt: nowIso,
          });
        }
      });
      emitTaskEvent(task, 'schedule.updated');
      return record;
    }

    const { session, updatedTask } = resolved;
    if (
      sameSessionRunning(session.id) &&
      task.overlapPolicy === 'skip' &&
      triggerKind !== 'manual'
    ) {
      const record: ScheduledTaskRun = {
        id: randomUUID(),
        taskId: task.id,
        triggerKind,
        scheduledFor,
        targetSessionId: session.id,
        runId: null,
        promptSnapshot: effectivePrompt,
        status: 'skipped',
        skipReason: 'session_busy',
        error: null,
        idempotencyKey: externalKey,
        triggerSource,
        chainDepth,
        createdAt: nowIso,
        finishedAt: nowIso,
      };
      store.transaction(() => {
        store.repos.schedules.insertRun(record);
        if (consumeSchedule) {
          store.repos.schedules.update(advanceTaskAfterOccurrence(updatedTask, nowDate, false));
        }
      });
      emitTaskEvent(updatedTask, 'schedule.run.updated');
      return record;
    }

    const runRecordId = randomUUID();
    const runIdempotencyKey = externalKey
      ? deterministicUuid(`schedule:${task.id}:key:${externalKey}`)
      : triggerKind === 'scheduled' || triggerKind === 'misfire'
        ? deterministicUuid(`schedule:${task.id}:${scheduledFor}`)
        : runRecordId;

    const initialRecord: ScheduledTaskRun = {
      id: runRecordId,
      taskId: task.id,
      triggerKind,
      scheduledFor,
      targetSessionId: session.id,
      runId: null,
      promptSnapshot: effectivePrompt,
      status: 'dispatched',
      skipReason: null,
      error: null,
      idempotencyKey: externalKey,
      triggerSource,
      chainDepth,
      createdAt: nowIso,
      finishedAt: null,
    };

    const nextTaskState = consumeSchedule
      ? advanceTaskAfterOccurrence(updatedTask, nowDate, true)
      : { ...updatedTask, lastRunAt: nowIso, updatedAt: nowIso };

    store.transaction(() => {
      store.repos.schedules.insertRun(initialRecord);
      store.repos.schedules.update(nextTaskState);
    });

    const nextVisited = Array.from(new Set([...(meta?.visitedTaskIds ?? []), task.id]));

    try {
      const result = await createRun(session.id, {
        text: effectivePrompt,
        idempotencyKey: runIdempotencyKey,
        mode: task.mode,
        executionPreference: task.executionPreference,
        ...(task.approvalMode ? { approvalMode: task.approvalMode } : {}),
        ...(task.maxSearchChargeFen > 0 ? { maxSearchChargeFen: task.maxSearchChargeFen } : {}),
        scheduleMeta: {
          taskId: task.id,
          taskName: task.title,
          triggerKind,
          scheduledFor,
          triggerSource,
          chainDepth,
          visitedTaskIds: nextVisited,
        },
      });
      let updatedRecord =
        store.repos.schedules.updateRun(runRecordId, {
          runId: result.run ? result.run.id : null,
          targetSessionId: session.id,
        }) ?? initialRecord;
      if (result.run && !activeStatuses.includes(result.run.status)) {
        updatedRecord = finalizeRunRecord(updatedRecord, result.run.id) ?? updatedRecord;
      } else {
        emitTaskEvent(nextTaskState, 'schedule.run.updated');
        emitTaskEvent(nextTaskState, 'schedule.updated');
      }
      return updatedRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法启动定时任务运行。';
      const failedAt = clock().toISOString();
      const failedRecord =
        store.repos.schedules.updateRun(runRecordId, {
          status: 'failed',
          error: message,
          finishedAt: failedAt,
        }) ?? initialRecord;
      const latestTask = store.repos.schedules.find(task.id);
      if (latestTask) {
        const failures = latestTask.consecutiveFailures + 1;
        const autoPaused = failures >= SCHEDULE_CONSECUTIVE_FAILURE_LIMIT;
        store.repos.schedules.update({
          ...latestTask,
          consecutiveFailures: failures,
          status: autoPaused ? 'paused' : latestTask.status,
          pauseReason: autoPaused ? 'consecutive_failures' : latestTask.pauseReason,
          updatedAt: failedAt,
        });
        emitTaskEvent(latestTask, 'schedule.updated');
      }
      emitTaskEvent(nextTaskState, 'schedule.run.updated');
      return failedRecord;
    }
  }

  async function processDueTasks(): Promise<void> {
    if (isShuttingDown()) return;
    const nowDate = clock();
    const nowIso = nowDate.toISOString();
    const due = store.repos.schedules.listDue(nowIso);
    for (const task of due) {
      if (isShuttingDown()) break;
      if (!task.nextRunAt) continue;
      const dueMs = new Date(task.nextRunAt).getTime();
      const isMisfire = nowDate.getTime() - dueMs > MISFIRE_THRESHOLD_MS;

      if (isMisfire && task.misfirePolicy === 'skip') {
        const record: ScheduledTaskRun = {
          id: randomUUID(),
          taskId: task.id,
          triggerKind: 'misfire',
          scheduledFor: task.nextRunAt,
          targetSessionId: task.targetSessionId,
          runId: null,
          promptSnapshot: task.prompt,
          status: 'skipped',
          skipReason: 'misfired',
          error: null,
          idempotencyKey: null,
          triggerSource: 'misfire',
          chainDepth: 0,
          createdAt: nowIso,
          finishedAt: nowIso,
        };
        store.transaction(() => {
          if (!store.repos.schedules.findRunByIdempotency(task.id, 'misfire', task.nextRunAt!)) {
            store.repos.schedules.insertRun(record);
          }
          store.repos.schedules.update(advanceTaskAfterOccurrence(task, nowDate, false));
        });
        emitTaskEvent(task, 'schedule.updated');
        continue;
      }

      // Reserve 1 global execution slot for interactive user sessions.
      if (store.repos.runs.listActive().length >= SCHEDULE_CONCURRENCY_CAP) {
        break;
      }

      await dispatchTask(task, isMisfire ? 'misfire' : 'scheduled', task.nextRunAt, true);
    }
  }

  async function tick(): Promise<void> {
    if (isShuttingDown()) return;
    if (runningTick) {
      tickAgain = true;
      return runningTick;
    }
    runningTick = (async () => {
      do {
        tickAgain = false;
        await processDueTasks();
      } while (tickAgain && !isShuttingDown());
    })()
      .catch((error) => {
        console.error('定时任务调度检查失败：', error);
      })
      .finally(() => {
        runningTick = undefined;
        armTimer();
      });
    return runningTick;
  }

  async function trigger(
    idOrSlug: string,
    options: TriggerScheduleOptions,
  ): Promise<TriggerScheduleResult> {
    if (isShuttingDown()) throw new AppError('SHUTTING_DOWN', '服务正在关闭。', 503);
    const task = store.repos.schedules.findByIdOrSlug(idOrSlug, options.projectId);
    if (!task) throw new AppError('NOT_FOUND', '定时任务不存在。', 404);

    if (task.status === 'paused' && !options.allowPaused) {
      throw new AppError('SCHEDULE_PAUSED', '该任务当前已暂停，请先恢复后再触发。', 409);
    }
    if (task.status === 'ended' && !options.allowPaused) {
      throw new AppError('SCHEDULE_ENDED', '该一次性任务已结束，请重新配置或手动试跑。', 409);
    }

    const chainDepth = options.chainDepth ?? 0;
    if (chainDepth > SCHEDULE_MAX_CHAIN_DEPTH) {
      throw new AppError(
        'SCHEDULE_CHAIN_DEPTH_EXCEEDED',
        `任务触发链路深度超过上限（最多 ${SCHEDULE_MAX_CHAIN_DEPTH} 层），已自动拦截。`,
        400,
      );
    }
    if (options.visitedTaskIds?.includes(task.id)) {
      throw new AppError(
        'SCHEDULE_CYCLE_DETECTED',
        '检测到任务自触发或循环触发，已自动拦截。',
        400,
      );
    }

    const idempotencyKey = options.idempotencyKey?.trim() || undefined;
    if (idempotencyKey) {
      const existing = store.repos.schedules.findRunByKey(task.id, idempotencyKey);
      if (existing) return { run: existing, deduplicated: true };
    }

    const nowIso = clock().toISOString();
    if (
      options.triggerKind !== 'manual' &&
      store.repos.runs.listActive().length >= SCHEDULE_CONCURRENCY_CAP &&
      task.overlapPolicy === 'skip'
    ) {
      const skipped: ScheduledTaskRun = {
        id: randomUUID(),
        taskId: task.id,
        triggerKind: options.triggerKind,
        scheduledFor: nowIso,
        targetSessionId: task.targetSessionId,
        runId: null,
        promptSnapshot: composeEffectivePrompt(task.prompt, options.input),
        status: 'skipped',
        skipReason: 'concurrency_cap',
        error: null,
        idempotencyKey: idempotencyKey ?? null,
        triggerSource: options.triggerSource ?? options.triggerKind,
        chainDepth,
        createdAt: nowIso,
        finishedAt: nowIso,
      };
      store.repos.schedules.insertRun(skipped);
      emitTaskEvent(task, 'schedule.run.updated');
      return { run: skipped, deduplicated: false };
    }

    const record = await dispatchTask(task, options.triggerKind, nowIso, false, {
      input: options.input,
      idempotencyKey,
      triggerSource: options.triggerSource ?? options.triggerKind,
      chainDepth,
      visitedTaskIds: options.visitedTaskIds,
    });
    armTimer();
    return { run: record, deduplicated: false };
  }

  async function runNow(
    idOrSlug: string,
    options?: Pick<
      TriggerScheduleOptions,
      'input' | 'idempotencyKey' | 'allowPaused' | 'triggerSource'
    >,
  ): Promise<ScheduledTaskRun> {
    const result = await trigger(idOrSlug, {
      triggerKind: 'manual',
      allowPaused: options?.allowPaused ?? true,
      input: options?.input,
      idempotencyKey: options?.idempotencyKey,
      triggerSource: options?.triggerSource ?? 'manual',
    });
    return result.run;
  }

  function finalizeRunRecord(
    record: ScheduledTaskRun,
    runId: string,
  ): ScheduledTaskRun | undefined {
    if (record.status !== 'dispatched') return record;
    let runStatus: string | undefined;
    let runError: string | null = null;
    try {
      const run = store.get('runs', runId);
      runStatus = run.status;
      runError = run.error;
    } catch {
      runStatus = 'failed';
    }
    const succeeded = runStatus === 'completed';
    const finishedAt = clock().toISOString();
    const updated = store.repos.schedules.updateRun(record.id, {
      status: succeeded ? 'completed' : 'failed',
      error: succeeded ? null : (runError ?? `运行以状态 ${runStatus ?? 'unknown'} 结束。`),
      finishedAt,
    });
    const task = store.repos.schedules.find(record.taskId);
    if (task) {
      const failures = succeeded ? 0 : task.consecutiveFailures + 1;
      const autoPaused = !succeeded && failures >= SCHEDULE_CONSECUTIVE_FAILURE_LIMIT;
      store.repos.schedules.update({
        ...task,
        consecutiveFailures: failures,
        status: autoPaused ? 'paused' : task.status,
        pauseReason: autoPaused ? 'consecutive_failures' : task.pauseReason,
        updatedAt: finishedAt,
      });
      const assistantText = store
        .list('messages')
        .filter((msg) => msg.runId === runId && msg.role === 'assistant')
        .map((msg) => msg.text)
        .join('\n');
      const notify = shouldNotifyScheduledRun(task.notifyPolicy, succeeded, assistantText);
      emitTaskEvent(task, 'schedule.updated');
      store.event(
        `schedule-${task.id}`,
        task.targetSessionId ?? `schedule:${task.projectId}`,
        'schedule.run.updated',
        {
          taskId: task.id,
          projectId: task.projectId,
          runId,
          status: succeeded ? 'completed' : 'failed',
          notify,
        },
      );
    }
    return updated;
  }

  const onRunEvent = (event: RunEvent) => {
    if (event.type !== 'run.finished') return;
    const record = store.repos.schedules.findRunByRunId(event.runId);
    if (record && record.status === 'dispatched') {
      finalizeRunRecord(record, event.runId);
    }
    if (started && !isShuttingDown()) void tick();
  };

  function start(): void {
    if (started) return;
    started = true;
    store.events.on('event', onRunEvent);
    void tick();
  }

  async function stop(): Promise<void> {
    started = false;
    clearTimer();
    store.events.off('event', onRunEvent);
    await runningTick;
  }

  return {
    start,
    stop,
    tick,
    reschedule: armTimer,
    wakeFromSuspend: () => {
      if (started && !isShuttingDown()) void tick();
    },
    trigger,
    runNow,
  };
}

export type ScheduleScheduler = ReturnType<typeof createScheduleScheduler>;
