/**
 * @file 定义定时任务与触发历史的 Drizzle 表结构。
 * @implementation 使用外键级联管理项目归属与会话解绑，并维护到期扫描与运行历史索引。
 * @updated 2026-11-27T13:05:00+08:00
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { projects, runs, sessions } from './session-snapshot.js';

export const scheduledTasks = sqliteTable('scheduled_tasks', {
  id: text('id').primaryKey().notNull(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  targetMode: text('target_mode').notNull(),
  targetSessionId: text('target_session_id').references(() => sessions.id, {
    onDelete: 'set null',
  }),
  agentRevisionId: text('agent_revision_id'),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  timingKind: text('timing_kind').notNull(),
  timingJson: text('timing_json').notNull(),
  timeZone: text('time_zone').notNull(),
  mode: text('mode').notNull(),
  approvalMode: text('approval_mode'),
  maxSearchChargeFen: integer('max_search_charge_fen').notNull().default(0),
  timeoutMs: integer('timeout_ms'),
  misfirePolicy: text('misfire_policy').notNull().default('run_once'),
  overlapPolicy: text('overlap_policy').notNull().default('skip'),
  notifyPolicy: text('notify_policy').notNull().default('on_error'),
  status: text('status').notNull().default('active'),
  pauseReason: text('pause_reason'),
  nextRunAt: text('next_run_at'),
  lastRunAt: text('last_run_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdBy: text('created_by').notNull(),
  createdSessionId: text('created_session_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const scheduledTaskRuns = sqliteTable('scheduled_task_runs', {
  id: text('id').primaryKey().notNull(),
  taskId: text('task_id')
    .notNull()
    .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
  triggerKind: text('trigger_kind').notNull(),
  scheduledFor: text('scheduled_for').notNull(),
  targetSessionId: text('target_session_id'),
  runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
  promptSnapshot: text('prompt_snapshot').notNull(),
  status: text('status').notNull(),
  skipReason: text('skip_reason'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  finishedAt: text('finished_at'),
});
