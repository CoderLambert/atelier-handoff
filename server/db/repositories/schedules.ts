/**
 * @file 提供定时任务及触发历史的 Drizzle SQLite 仓储。
 * @implementation 负责任务增删改查、到期扫描、运行历史记录与 200 条上限裁剪。
 * @updated 2026-11-27T13:08:00+08:00
 */
import { and, asc, desc, eq, inArray, isNotNull, lte, notInArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { AppError } from '../../../shared/errors.js';
import {
  SCHEDULE_HISTORY_LIMIT,
  scheduledTaskRunSchema,
  scheduledTaskSchema,
  scheduleTimingSchema,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduleStatus,
} from '../../../shared/schedules.js';
import { scheduledTaskRuns, scheduledTasks } from '../schema/schedules.js';

type TaskRow = typeof scheduledTasks.$inferSelect;
type RunRow = typeof scheduledTaskRuns.$inferSelect;

function toTask(row: TaskRow): ScheduledTask {
  return scheduledTaskSchema.parse({
    id: row.id,
    projectId: row.projectId,
    targetMode: row.targetMode,
    targetSessionId: row.targetSessionId,
    agentRevisionId: row.agentRevisionId,
    title: row.title,
    prompt: row.prompt,
    timing: scheduleTimingSchema.parse(JSON.parse(row.timingJson) as unknown),
    timeZone: row.timeZone,
    mode: row.mode,
    approvalMode: row.approvalMode,
    maxSearchChargeFen: row.maxSearchChargeFen,
    timeoutMs: row.timeoutMs,
    misfirePolicy: row.misfirePolicy,
    overlapPolicy: row.overlapPolicy,
    notifyPolicy: row.notifyPolicy,
    status: row.status,
    pauseReason: row.pauseReason,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    consecutiveFailures: row.consecutiveFailures,
    createdBy: row.createdBy,
    createdSessionId: row.createdSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toTaskRow(task: ScheduledTask): typeof scheduledTasks.$inferInsert {
  return {
    id: task.id,
    projectId: task.projectId,
    targetMode: task.targetMode,
    targetSessionId: task.targetSessionId,
    agentRevisionId: task.agentRevisionId,
    title: task.title,
    prompt: task.prompt,
    timingKind: task.timing.kind,
    timingJson: JSON.stringify(task.timing),
    timeZone: task.timeZone,
    mode: task.mode,
    approvalMode: task.approvalMode,
    maxSearchChargeFen: task.maxSearchChargeFen,
    timeoutMs: task.timeoutMs,
    misfirePolicy: task.misfirePolicy,
    overlapPolicy: task.overlapPolicy,
    notifyPolicy: task.notifyPolicy,
    status: task.status,
    pauseReason: task.pauseReason,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    consecutiveFailures: task.consecutiveFailures,
    createdBy: task.createdBy,
    createdSessionId: task.createdSessionId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function toTaskRun(row: RunRow): ScheduledTaskRun {
  return scheduledTaskRunSchema.parse({
    id: row.id,
    taskId: row.taskId,
    triggerKind: row.triggerKind,
    scheduledFor: row.scheduledFor,
    targetSessionId: row.targetSessionId,
    runId: row.runId,
    promptSnapshot: row.promptSnapshot,
    status: row.status,
    skipReason: row.skipReason,
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  });
}

export function scheduleRepository(orm: BetterSQLite3Database) {
  function list(filter?: { projectId?: string; status?: ScheduleStatus }): ScheduledTask[] {
    const conditions = [];
    if (filter?.projectId) conditions.push(eq(scheduledTasks.projectId, filter.projectId));
    if (filter?.status) conditions.push(eq(scheduledTasks.status, filter.status));
    const query = orm.select().from(scheduledTasks);
    const rows = (conditions.length > 0 ? query.where(and(...conditions)) : query)
      .orderBy(desc(scheduledTasks.updatedAt))
      .all();
    return rows.map(toTask);
  }

  function find(id: string): ScheduledTask | undefined {
    const row = orm.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get();
    return row ? toTask(row) : undefined;
  }

  function get(id: string): ScheduledTask {
    const task = find(id);
    if (!task) throw new AppError('NOT_FOUND', '定时任务不存在。', 404);
    return task;
  }

  function listDue(atIso: string): ScheduledTask[] {
    const rows = orm
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.status, 'active'),
          isNotNull(scheduledTasks.nextRunAt),
          lte(scheduledTasks.nextRunAt, atIso),
        ),
      )
      .orderBy(asc(scheduledTasks.nextRunAt))
      .all();
    return rows.map(toTask);
  }

  function nextDue(): ScheduledTask | undefined {
    const row = orm
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.status, 'active'), isNotNull(scheduledTasks.nextRunAt)))
      .orderBy(asc(scheduledTasks.nextRunAt))
      .limit(1)
      .get();
    return row ? toTask(row) : undefined;
  }

  function listByTargetSession(sessionId: string): ScheduledTask[] {
    return orm
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.targetSessionId, sessionId))
      .all()
      .map(toTask);
  }

  function insert(task: ScheduledTask): ScheduledTask {
    orm.insert(scheduledTasks).values(toTaskRow(task)).run();
    return task;
  }

  function update(task: ScheduledTask): ScheduledTask {
    const result = orm
      .update(scheduledTasks)
      .set(toTaskRow(task))
      .where(eq(scheduledTasks.id, task.id))
      .run();
    if (result.changes === 0) throw new AppError('NOT_FOUND', '定时任务不存在。', 404);
    return task;
  }

  function remove(id: string): boolean {
    const result = orm.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).run();
    return result.changes > 0;
  }

  function pruneRuns(taskId: string): void {
    const keep = orm
      .select({ id: scheduledTaskRuns.id })
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.taskId, taskId))
      .orderBy(desc(scheduledTaskRuns.createdAt))
      .limit(SCHEDULE_HISTORY_LIMIT)
      .all()
      .map((entry) => entry.id);
    if (keep.length < SCHEDULE_HISTORY_LIMIT) return;
    orm
      .delete(scheduledTaskRuns)
      .where(and(eq(scheduledTaskRuns.taskId, taskId), notInArray(scheduledTaskRuns.id, keep)))
      .run();
  }

  function insertRun(record: ScheduledTaskRun): ScheduledTaskRun {
    orm
      .insert(scheduledTaskRuns)
      .values({
        id: record.id,
        taskId: record.taskId,
        triggerKind: record.triggerKind,
        scheduledFor: record.scheduledFor,
        targetSessionId: record.targetSessionId,
        runId: record.runId,
        promptSnapshot: record.promptSnapshot,
        status: record.status,
        skipReason: record.skipReason,
        error: record.error,
        createdAt: record.createdAt,
        finishedAt: record.finishedAt,
      })
      .run();
    pruneRuns(record.taskId);
    return record;
  }

  function findRunByIdempotency(
    taskId: string,
    triggerKind: 'scheduled' | 'misfire',
    scheduledFor: string,
  ): ScheduledTaskRun | undefined {
    const row = orm
      .select()
      .from(scheduledTaskRuns)
      .where(
        and(
          eq(scheduledTaskRuns.taskId, taskId),
          eq(scheduledTaskRuns.triggerKind, triggerKind),
          eq(scheduledTaskRuns.scheduledFor, scheduledFor),
        ),
      )
      .get();
    return row ? toTaskRun(row) : undefined;
  }

  function findRunByRunId(runId: string): ScheduledTaskRun | undefined {
    const row = orm
      .select()
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.runId, runId))
      .get();
    return row ? toTaskRun(row) : undefined;
  }

  function updateRun(
    id: string,
    patch: Partial<
      Pick<
        ScheduledTaskRun,
        'runId' | 'targetSessionId' | 'status' | 'skipReason' | 'error' | 'finishedAt'
      >
    >,
  ): ScheduledTaskRun | undefined {
    const existing = orm.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.id, id)).get();
    if (!existing) return undefined;
    const next: ScheduledTaskRun = {
      ...toTaskRun(existing),
      ...patch,
    };
    orm
      .update(scheduledTaskRuns)
      .set({
        runId: next.runId,
        targetSessionId: next.targetSessionId,
        status: next.status,
        skipReason: next.skipReason,
        error: next.error,
        finishedAt: next.finishedAt,
      })
      .where(eq(scheduledTaskRuns.id, id))
      .run();
    return next;
  }

  function listRuns(taskId: string, limit = 50): ScheduledTaskRun[] {
    const bounded = Math.max(1, Math.min(limit, SCHEDULE_HISTORY_LIMIT));
    return orm
      .select()
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.taskId, taskId))
      .orderBy(desc(scheduledTaskRuns.createdAt))
      .limit(bounded)
      .all()
      .map(toTaskRun);
  }

  function listDispatchedRuns(): ScheduledTaskRun[] {
    return orm
      .select()
      .from(scheduledTaskRuns)
      .where(inArray(scheduledTaskRuns.status, ['dispatched']))
      .all()
      .map(toTaskRun);
  }

  return {
    list,
    find,
    get,
    listDue,
    nextDue,
    listByTargetSession,
    insert,
    update,
    remove,
    insertRun,
    findRunByIdempotency,
    findRunByRunId,
    updateRun,
    listRuns,
    listDispatchedRuns,
  };
}

export type ScheduleRepository = ReturnType<typeof scheduleRepository>;
