/**
 * @file 注册定时任务管理相关的内置 MCP 工具。
 * @implementation 允许会话内 Agent 列出、创建、更新或删除定时任务；创建或提权至 edit + automatic 或修改高权限任务提示词时强制走人工审批。
 * @updated 2026-11-27T13:18:00+08:00
 */
import { z } from 'zod';
import { AppError } from '../../../../shared/errors.js';
import {
  scheduleMisfirePolicySchema,
  scheduleNotifyPolicySchema,
  scheduleOverlapPolicySchema,
  scheduleTargetModeSchema,
  scheduleTimingSchema,
} from '../../../../shared/schedules.js';
import type { RunMcpToolHost, ToolRegistration } from './types.js';

export function registerScheduleTools(host: RunMcpToolHost, registration: ToolRegistration) {
  const { schedules, run, projectId, approve, toolSignal, verifyCurrent } = host;
  if (!schedules) return;
  const { custom, mcpTools } = registration;

  mcpTools.push(
    custom(
      'list_scheduled_tasks',
      'List scheduled automation tasks in the current project, including their id, title, timing, status, and nextRunAt.',
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
      'Create a durable scheduled automation task in the current project. Defaults to readonly mode and dedicated automation session (new_once). Creating an edit + automatic task requires explicit manual user approval.',
      {
        title: z.string().trim().min(1).max(160),
        prompt: z.string().trim().min(1).max(32_000),
        timing: scheduleTimingSchema,
        timeZone: z.string().trim().min(1).max(100).optional(),
        targetMode: scheduleTargetModeSchema.default('new_once'),
        targetSessionId: z.string().min(1).nullable().optional(),
        mode: z.enum(['readonly', 'edit']).default('readonly'),
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
          args.mode === 'edit' &&
          (args.approvalMode === 'automatic' || args.maxSearchChargeFen > 0);
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
            title: args.title,
            prompt: args.prompt,
            timing: args.timing,
            ...(args.timeZone ? { timeZone: args.timeZone } : {}),
            targetMode: args.targetMode,
            targetSessionId,
            mode: args.mode,
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
        title: z.string().trim().min(1).max(160).optional(),
        prompt: z.string().trim().min(1).max(32_000).optional(),
        timing: scheduleTimingSchema.optional(),
        timeZone: z.string().trim().min(1).max(100).optional(),
        mode: z.enum(['readonly', 'edit']).optional(),
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
        const escalatesPrivilege =
          nextMode === 'edit' &&
          nextApproval === 'automatic' &&
          (current.approvalMode !== 'automatic' ||
            args.prompt !== undefined ||
            (args.maxSearchChargeFen !== undefined &&
              args.maxSearchChargeFen > current.maxSearchChargeFen));
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
  );
}
