/**
 * @file 定义定时任务与运行历史的共享 Schema 与类型契约。
 * @implementation 用 Zod 统一前后端、HTTP 接口、MCP 工具与 SQLite 持久层的调度规则、执行策略与状态校验。
 * @updated 2026-11-27T13:05:00+08:00
 */
import { z } from 'zod';

export const scheduleTargetModeSchema = z.enum(['session', 'new_once', 'new']);
export type ScheduleTargetMode = z.infer<typeof scheduleTargetModeSchema>;

export const scheduleMisfirePolicySchema = z.enum(['run_once', 'skip']);
export type ScheduleMisfirePolicy = z.infer<typeof scheduleMisfirePolicySchema>;

export const scheduleOverlapPolicySchema = z.enum(['skip', 'queue']);
export type ScheduleOverlapPolicy = z.infer<typeof scheduleOverlapPolicySchema>;

export const scheduleNotifyPolicySchema = z.enum(['always', 'on_error', 'on_attention', 'never']);
export type ScheduleNotifyPolicy = z.infer<typeof scheduleNotifyPolicySchema>;

export const scheduleStatusSchema = z.enum(['active', 'paused', 'ended']);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const scheduleRunTriggerKindSchema = z.enum(['scheduled', 'manual', 'misfire']);
export type ScheduleRunTriggerKind = z.infer<typeof scheduleRunTriggerKindSchema>;

export const scheduleRunStatusSchema = z.enum(['dispatched', 'completed', 'failed', 'skipped']);
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>;

export const scheduleCreatedBySchema = z.enum(['user', 'agent']);
export type ScheduleCreatedBy = z.infer<typeof scheduleCreatedBySchema>;

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const scheduleOnceTimingSchema = z
  .object({
    kind: z.literal('once'),
    runAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const scheduleIntervalTimingSchema = z
  .object({
    kind: z.literal('interval'),
    everySeconds: z.number().int().min(60).max(31_536_000),
    anchorAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const scheduleDailyTimingSchema = z
  .object({
    kind: z.literal('daily'),
    time: z.string().regex(hhmmRegex, '时间格式需为 HH:mm'),
    everyDays: z.number().int().min(1).max(365).default(1),
  })
  .strict();

export const scheduleWeeklyTimingSchema = z
  .object({
    kind: z.literal('weekly'),
    time: z.string().regex(hhmmRegex, '时间格式需为 HH:mm'),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, '星期不能重复'),
  })
  .strict();

export const scheduleCronTimingSchema = z
  .object({
    kind: z.literal('cron'),
    expression: z.string().trim().min(9).max(120),
  })
  .strict();

export const scheduleTimingSchema = z.discriminatedUnion('kind', [
  scheduleOnceTimingSchema,
  scheduleIntervalTimingSchema,
  scheduleDailyTimingSchema,
  scheduleWeeklyTimingSchema,
  scheduleCronTimingSchema,
]);
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;

export const runScheduleMetaSchema = z
  .object({
    taskId: z.string().min(1),
    taskName: z.string().min(1),
    triggerKind: scheduleRunTriggerKindSchema,
    scheduledFor: z.string().datetime({ offset: true }),
  })
  .strict();
export type RunScheduleMeta = z.infer<typeof runScheduleMetaSchema>;

export const scheduledTaskSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    targetMode: scheduleTargetModeSchema,
    targetSessionId: z.string().min(1).nullable(),
    agentRevisionId: z.string().min(1).nullable(),
    title: z.string().min(1).max(160),
    prompt: z.string().min(1).max(32_000),
    timing: scheduleTimingSchema,
    timeZone: z.string().min(1).max(100),
    mode: z.enum(['readonly', 'edit']),
    approvalMode: z.literal('automatic').nullable(),
    maxSearchChargeFen: z.number().int().min(0).max(100_000),
    timeoutMs: z.number().int().min(10_000).max(3_600_000).nullable(),
    misfirePolicy: scheduleMisfirePolicySchema,
    overlapPolicy: scheduleOverlapPolicySchema,
    notifyPolicy: scheduleNotifyPolicySchema,
    status: scheduleStatusSchema,
    pauseReason: z.string().max(200).nullable(),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
    lastRunAt: z.string().datetime({ offset: true }).nullable(),
    consecutiveFailures: z.number().int().min(0),
    createdBy: scheduleCreatedBySchema,
    createdSessionId: z.string().min(1).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export const scheduledTaskRunSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    triggerKind: scheduleRunTriggerKindSchema,
    scheduledFor: z.string().datetime({ offset: true }),
    targetSessionId: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    promptSnapshot: z.string(),
    status: scheduleRunStatusSchema,
    skipReason: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>;

export const createScheduledTaskInputSchema = z
  .object({
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(32_000),
    timing: scheduleTimingSchema,
    timeZone: z.string().trim().min(1).max(100).optional(),
    targetMode: scheduleTargetModeSchema.default('new_once'),
    targetSessionId: z.string().min(1).nullable().optional(),
    agentRevisionId: z.string().min(1).nullable().optional(),
    mode: z.enum(['readonly', 'edit']).default('readonly'),
    approvalMode: z.literal('automatic').nullable().optional(),
    maxSearchChargeFen: z.number().int().min(0).max(100_000).default(0),
    timeoutMs: z.number().int().min(10_000).max(3_600_000).nullable().optional(),
    misfirePolicy: scheduleMisfirePolicySchema.default('run_once'),
    overlapPolicy: scheduleOverlapPolicySchema.default('skip'),
    notifyPolicy: scheduleNotifyPolicySchema.default('on_error'),
  })
  .strict();
export type CreateScheduledTaskInput = z.infer<typeof createScheduledTaskInputSchema>;

export const updateScheduledTaskInputSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    title: z.string().trim().min(1).max(160).optional(),
    prompt: z.string().trim().min(1).max(32_000).optional(),
    timing: scheduleTimingSchema.optional(),
    timeZone: z.string().trim().min(1).max(100).optional(),
    targetMode: scheduleTargetModeSchema.optional(),
    targetSessionId: z.string().min(1).nullable().optional(),
    agentRevisionId: z.string().min(1).nullable().optional(),
    mode: z.enum(['readonly', 'edit']).optional(),
    approvalMode: z.literal('automatic').nullable().optional(),
    maxSearchChargeFen: z.number().int().min(0).max(100_000).optional(),
    timeoutMs: z.number().int().min(10_000).max(3_600_000).nullable().optional(),
    misfirePolicy: scheduleMisfirePolicySchema.optional(),
    overlapPolicy: scheduleOverlapPolicySchema.optional(),
    notifyPolicy: scheduleNotifyPolicySchema.optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .strict();
export type UpdateScheduledTaskInput = z.infer<typeof updateScheduledTaskInputSchema>;

export const SCHEDULE_CONSECUTIVE_FAILURE_LIMIT = 5;
export const SCHEDULE_HISTORY_LIMIT = 200;
export const SCHEDULE_MIN_NEW_SESSION_INTERVAL_SECONDS = 300;
