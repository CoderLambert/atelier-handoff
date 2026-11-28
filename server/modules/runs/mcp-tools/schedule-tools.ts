/**
 * @file 注册定时任务管理与跨会话触发相关的内置 MCP 工具。
 * @implementation 允许会话内 Agent 列出、创建、更新、删除、按需触发或查询定时任务运行结果；涉及高权限写任务时强制走人工审批并传递链路深度防环。
 * @updated 2026-11-27T15:10:00+08:00
 */
import { z } from 'zod';
import { AppError } from '../../../../shared/errors.js';
import {
  SCHEDULE_TRIGGER_INPUT_MAX_LENGTH,
  scheduleEffortSchema,
  scheduleExecutionPreferenceSchema,
  scheduleModelSchema,
  scheduleMisfirePolicySchema,
  scheduleNotifyPolicySchema,
  scheduleOverlapPolicySchema,
  scheduleSlugSchema,
  scheduleTargetModeSchema,
  scheduleTimingSchema,
} from '../../../../shared/schedules.js';
import type { RunMcpToolHost, ToolRegistration } from './types.js';

export function registerScheduleTools(host: RunMcpToolHost, registration: ToolRegistration) {
  const { schedules, run, projectId, approve, toolSignal, verifyCurrent, automaticApproval } = host;
  if (!schedules) return;
  const { custom, mcpTools } = registration;

  mcpTools.push(
    custom(
      'list_scheduled_tasks',
      'List scheduled or on-demand automation tasks in the current project, including their id, slug, title, timing, status, and nextRunAt.',
      {
        status: z.enum(['active', 'paused', 'ended']).optional(),
      },
      async (args) => {
        verifyCurrent();
        return { items: schedules.list({ projectId, status: args.status }) };
      },
    ),
    custom(
      'create_scheduled_task',
      'Create a durable scheduled or on-demand (timing.kind="manual") automation task in the current project. Optional slug provides a stable alias for triggering. Creating an edit + automatic task requires explicit manual user approval.',
      {
        slug: scheduleSlugSchema.nullable().optional(),
        title: z.string().trim().min(1).max(160),
        prompt: z.string().trim().min(1).max(32_000),
        timing: scheduleTimingSchema,
        timeZone: z.string().trim().min(1).max(100).optional(),
        targetMode: scheduleTargetModeSchema.default('new_once'),
        targetSessionId: z.string().min(1).nullable().optional(),
        model: scheduleModelSchema.nullable().optional(),
        effort: scheduleEffortSchema.nullable().optional(),
        mode: z.enum(['readonly', 'edit']).default('readonly'),
        executionPreference: scheduleExecutionPreferenceSchema.default('project-v1'),
        approvalMode: z.literal('automatic').nullable().optional(),
        maxSearchChargeFen: z.number().int().min(0).max(100_000).default(0),
        misfirePolicy: scheduleMisfirePolicySchema.default('run_once'),
        overlapPolicy: scheduleOverlapPolicySchema.default('skip'),
        notifyPolicy: scheduleNotifyPolicySchema.default('on_error'),
        reason: z.string().trim().min(1).max(500).optional(),
      },
      async (args, toolCallId) => {
        const targetSessionId =
          args.targetMode === 'session'
            ? (args.targetSessionId ?? run.sessionId)
            : (args.targetSessionId ?? null);
        const requiresManual =
          args.executionPreference === 'native-v1' ||
          (args.mode === 'edit' &&
            (args.approvalMode === 'automatic' || args.maxSearchChargeFen > 0));
        if (requiresManual) {
          await approve(
            {
              toolCallId,
              kind: 'mcp',
              command: `create_scheduled_task: ${args.title} (${args.mode}/${args.approvalMode ?? 'manual'})`,
              reason:
                args.reason ?? `创建具有无人值守修改权限的定时任务「${args.title}」需要人工确认。`,
              requireManual: true,
            },
            toolSignal(),
          );
        }
        verifyCurrent();
        const task = schedules.create(
          {
            projectId,
            ...(args.slug !== undefined ? { slug: args.slug } : {}),
            title: args.title,
            prompt: args.prompt,
            timing: args.timing,
            ...(args.timeZone ? { timeZone: args.timeZone } : {}),
            targetMode: args.targetMode,
            targetSessionId,
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.effort !== undefined ? { effort: args.effort } : {}),
            mode: args.mode,
            executionPreference: args.executionPreference,
            approvalMode: args.approvalMode ?? null,
            maxSearchChargeFen: args.maxSearchChargeFen,
            misfirePolicy: args.misfirePolicy,
            overlapPolicy: args.overlapPolicy,
            notifyPolicy: args.notifyPolicy,
          },
          { createdBy: 'agent', createdSessionId: run.sessionId },
        );
        return { task };
      },
    ),
    custom(
      'update_scheduled_task',
      'Update, pause, or resume an existing scheduled task in the current project. Editing a paused task keeps it paused unless status="active" is explicitly passed.',
      {
        id: z.string().min(1),
        expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
        slug: scheduleSlugSchema.nullable().optional(),
        title: z.string().trim().min(1).max(160).optional(),
        prompt: z.string().trim().min(1).max(32_000).optional(),
        timing: scheduleTimingSchema.optional(),
        timeZone: z.string().trim().min(1).max(100).optional(),
        model: scheduleModelSchema.nullable().optional(),
        effort: scheduleEffortSchema.nullable().optional(),
        mode: z.enum(['readonly', 'edit']).optional(),
        executionPreference: scheduleExecutionPreferenceSchema.optional(),
        approvalMode: z.literal('automatic').nullable().optional(),
        maxSearchChargeFen: z.number().int().min(0).max(100_000).optional(),
        status: z.enum(['active', 'paused']).optional(),
        reason: z.string().trim().min(1).max(500).optional(),
      },
      async (args, toolCallId) => {
        const current = schedules.get(args.id);
        if (current.projectId !== projectId) {
          throw new AppError('NOT_FOUND', '当前项目不存在该定时任务。', 404);
        }
        const nextMode = args.mode ?? current.mode;
        const nextApproval =
          args.approvalMode !== undefined
            ? args.approvalMode
            : nextMode === 'readonly'
              ? null
              : current.approvalMode;
        const nextExec = args.executionPreference ?? current.executionPreference;
        const escalatesPrivilege =
          (nextExec === 'native-v1' &&
            (current.executionPreference !== 'native-v1' || args.prompt !== undefined)) ||
          (nextMode === 'edit' &&
            nextApproval === 'automatic' &&
            (current.approvalMode !== 'automatic' ||
              args.prompt !== undefined ||
              (args.maxSearchChargeFen !== undefined &&
                args.maxSearchChargeFen > current.maxSearchChargeFen)));
        if (escalatesPrivilege) {
          await approve(
            {
              toolCallId,
              kind: 'mcp',
              command: `update_scheduled_task: ${current.title} (${nextMode}/${nextApproval ?? 'manual'})`,
              reason: args.reason ?? `修改高权限无人值守定时任务「${current.title}」需要人工确认。`,
              requireManual: true,
            },
            toolSignal(),
          );
        }
        verifyCurrent();
        const { id, reason: _reason, ...patch } = args;
        const task = schedules.update(id, patch);
        return { task };
      },
    ),
    custom(
      'delete_scheduled_task',
      'Delete a scheduled automation task in the current project. Existing conversation sessions are preserved.',
      {
        id: z.string().min(1),
      },
      async (args) => {
        const current = schedules.get(args.id);
        if (current.projectId !== projectId) {
          throw new AppError('NOT_FOUND', '当前项目不存在该定时任务。', 404);
        }
        verifyCurrent();
        schedules.remove(args.id);
        return { deleted: true, id: args.id };
      },
    ),
    custom(
      'trigger_scheduled_task',
      'Asynchronously trigger an automation task in the current project by its id or slug. Optional input is appended to this single run without mutating the task template. Returns immediately with the task run record.',
      {
        target: z.string().trim().min(1).max(160),
        input: z.string().trim().min(1).max(SCHEDULE_TRIGGER_INPUT_MAX_LENGTH).optional(),
        idempotencyKey: z.string().trim().min(1).max(160).optional(),
        reason: z.string().trim().min(1).max(500).optional(),
      },
      async (args, toolCallId) => {
        const targetTask = schedules.resolve(args.target, projectId);
        const requiresManual =
          (targetTask.executionPreference === 'native-v1' && !host.native) ||
          (targetTask.mode === 'edit' &&
            targetTask.approvalMode === 'automatic' &&
            !automaticApproval);
        if (requiresManual) {
          await approve(
            {
              toolCallId,
              kind: 'mcp',
              command: `trigger_scheduled_task: ${targetTask.slug ?? targetTask.title}`,
              reason:
                args.reason ??
                `触发具有无人值守修改权限的任务「${targetTask.title}」需要人工确认。`,
              requireManual: true,
            },
            toolSignal(),
          );
        }
        verifyCurrent();
        const currentMeta = run.scheduleMeta;
        const visitedTaskIds = Array.from(
          new Set([
            ...(currentMeta?.visitedTaskIds ?? []),
            ...(currentMeta?.taskId ? [currentMeta.taskId] : []),
          ]),
        );
        const nextChainDepth = currentMeta ? (currentMeta.chainDepth ?? 0) + 1 : 1;
        const triggerSource = currentMeta
          ? `task:${currentMeta.taskId}`
          : `session:${run.sessionId}`;
        const result = await schedules.trigger(targetTask.id, {
          triggerKind: 'agent',
          projectId,
          input: args.input,
          idempotencyKey: args.idempotencyKey,
          triggerSource,
          chainDepth: nextChainDepth,
          visitedTaskIds,
          allowPaused: false,
        });
        return {
          task: {
            id: targetTask.id,
            slug: targetTask.slug,
            title: targetTask.title,
          },
          run: result.run,
          deduplicated: result.deduplicated,
        };
      },
    ),
    custom(
      'get_scheduled_task_run',
      'Read the status and result metadata of a previously triggered automation task run in the current project.',
      {
        runRecordId: z.string().trim().min(1),
      },
      async (args) => {
        verifyCurrent();
        const record = schedules.getRun(args.runRecordId);
        const task = schedules.get(record.taskId);
        if (task.projectId !== projectId) {
          throw new AppError('NOT_FOUND', '当前项目不存在该任务运行记录。', 404);
        }
        return {
          task: {
            id: task.id,
            slug: task.slug,
            title: task.title,
          },
          run: record,
        };
      },
    ),
  );
}
