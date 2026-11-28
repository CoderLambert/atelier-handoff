/**
 * @file 提供定时任务的增删改查、别名寻址、单任务远程令牌签发与会话生命周期联动。
 * @implementation 统一校验项目、目标会话、权限组合与调度规则；修改已暂停任务时保持暂停，归档/删除目标会话时安全暂停关联任务。
 * @updated 2026-11-27T15:05:00+08:00
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../../shared/errors.js';
import {
  createScheduledTaskInputSchema,
  updateScheduledTaskInputSchema,
  type ScheduleCreatedBy,
  type ScheduleExecutionPreference,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduleStatus,
} from '../../../shared/schedules.js';
import type { AgentProfiles } from '../../agent-profiles.js';
import type { Store } from '../../store.js';
import {
  computeNextRunAt,
  normalizeTiming,
  resolveSystemTimeZone,
  timingEquals,
  validateTimeZone,
} from './timing.js';

function hashTriggerToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function safeHashEqual(leftHex: string, rightHex: string): boolean {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface ScheduleServiceOptions {
  store: Pick<Store, 'get' | 'transaction' | 'event' | 'repos'>;
  agents: Pick<AgentProfiles, 'requireReady'>;
  nativeExecution?: boolean;
  clock?: () => Date;
  onChanged?: () => void;
}

export function createScheduleService({
  store,
  agents,
  nativeExecution = false,
  clock = () => new Date(),
  onChanged,
}: ScheduleServiceOptions) {
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

  function validatePolicyCombination(
    mode: 'readonly' | 'edit',
    executionPreference: ScheduleExecutionPreference,
    approvalMode: 'automatic' | null,
    maxSearchChargeFen: number,
    agentRevisionId: string | null,
  ): void {
    if (executionPreference === 'native-v1') {
      if (!nativeExecution) {
        throw new AppError(
          'NATIVE_EXECUTION_UNAVAILABLE',
          '本机项目环境执行仅在已配对的 Linux 桌面端可用。',
          403,
        );
      }
      if (agentRevisionId) {
        throw new AppError('AGENT_MODE_DENIED', '绑定智能体的任务不支持本机项目环境执行。', 403);
      }
      if (mode !== 'edit' || approvalMode !== null || maxSearchChargeFen > 0) {
        throw new AppError(
          'NATIVE_EXECUTION_INVALID',
          '本机项目环境执行需使用修改权限，且不能与全工具自动审批组合。',
          400,
        );
      }
      return;
    }
    if (approvalMode === 'automatic' && mode !== 'edit') {
      throw new AppError(
        'AUTOMATION_MODE_INVALID',
        '全工具自动化需要受控修改（edit）权限模式。',
        400,
      );
    }
    if (maxSearchChargeFen > 0 && approvalMode !== 'automatic') {
      throw new AppError(
        'AUTOMATION_BUDGET_INVALID',
        '搜索费用上限仅适用于全工具自动化任务。',
        400,
      );
    }
  }

  function validateSlugUnique(
    projectId: string,
    slug: string | null,
    excludeTaskId?: string,
  ): void {
    if (!slug) return;
    const conflict = store.repos.schedules.findBySlug(projectId, slug);
    if (conflict && conflict.id !== excludeTaskId) {
      throw new AppError(
        'SCHEDULE_SLUG_CONFLICT',
        `当前项目已存在别名为「${slug}」的自动化任务。`,
        409,
      );
    }
  }

  function validateTargetSession(
    projectId: string,
    targetMode: ScheduledTask['targetMode'],
    targetSessionId: string | null,
  ): string | null {
    if (targetMode === 'new') return null;
    if (targetMode === 'session') {
      if (!targetSessionId) {
        throw new AppError('INVALID_INPUT', '指定已有会话模式必须选择目标会话。', 400);
      }
      const session = store.get('sessions', targetSessionId);
      if (session.projectId !== projectId) {
        throw new AppError('INVALID_INPUT', '目标会话不属于当前项目。', 400);
      }
      if (session.status !== 'active') {
        throw new AppError('SCHEDULE_TARGET_ARCHIVED', '目标会话已归档，请先恢复或更换目标。', 409);
      }
      return session.id;
    }
    if (targetSessionId) {
      const session = store.get('sessions', targetSessionId);
      if (session.projectId !== projectId) {
        throw new AppError('INVALID_INPUT', '目标会话不属于当前项目。', 400);
      }
      return session.id;
    }
    return null;
  }

  function list(filter?: { projectId?: string; status?: ScheduleStatus }): ScheduledTask[] {
    return store.repos.schedules.list(filter);
  }

  function get(id: string): ScheduledTask {
    return store.repos.schedules.get(id);
  }

  function resolve(idOrSlug: string, projectId?: string): ScheduledTask {
    const task = store.repos.schedules.findByIdOrSlug(idOrSlug, projectId);
    if (!task) throw new AppError('NOT_FOUND', '定时任务不存在。', 404);
    return task;
  }

  function listRuns(id: string, limit = 50): ScheduledTaskRun[] {
    store.repos.schedules.get(id);
    return store.repos.schedules.listRuns(id, limit);
  }

  function getRun(runRecordId: string): ScheduledTaskRun {
    const run = store.repos.schedules.findRunById(runRecordId);
    if (!run) throw new AppError('NOT_FOUND', '任务运行记录不存在。', 404);
    return run;
  }

  function create(
    raw: unknown,
    actor: { createdBy: ScheduleCreatedBy; createdSessionId?: string | null } = {
      createdBy: 'user',
    },
  ): ScheduledTask {
    const input = createScheduledTaskInputSchema.parse(raw);
    const nowDate = clock();
    const nowIso = nowDate.toISOString();
    const project = store.get('projects', input.projectId);
    const slug = input.slug ?? null;
    validateSlugUnique(project.id, slug);
    const timeZone = validateTimeZone(input.timeZone ?? resolveSystemTimeZone());
    const approvalMode = input.approvalMode ?? null;
    validatePolicyCombination(
      input.mode,
      input.executionPreference,
      approvalMode,
      input.maxSearchChargeFen,
      input.agentRevisionId ?? null,
    );
    const targetSessionId = validateTargetSession(
      project.id,
      input.targetMode,
      input.targetSessionId ?? null,
    );
    if (input.agentRevisionId) agents.requireReady(project.id, input.agentRevisionId);
    const timing = normalizeTiming(input.timing, timeZone, input.targetMode, nowDate);
    const nextRunAt = computeNextRunAt(timing, timeZone, nowDate);
    if (timing.kind !== 'manual' && !nextRunAt) {
      throw new AppError('SCHEDULE_INVALID_TIMING', '定时任务的执行时间必须晚于当前时刻。', 400);
    }
    const task: ScheduledTask = {
      id: randomUUID(),
      projectId: project.id,
      slug,
      targetMode: input.targetMode,
      targetSessionId,
      agentRevisionId: input.agentRevisionId ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      title: input.title,
      prompt: input.prompt,
      timing,
      timeZone,
      mode: input.mode,
      executionPreference: input.executionPreference,
      approvalMode,
      maxSearchChargeFen: input.maxSearchChargeFen,
      timeoutMs: input.timeoutMs ?? null,
      misfirePolicy: input.misfirePolicy,
      overlapPolicy: input.overlapPolicy,
      notifyPolicy: input.notifyPolicy,
      remoteTriggerEnabled: false,
      hasTriggerToken: false,
      status: 'active',
      pauseReason: null,
      nextRunAt,
      lastRunAt: null,
      consecutiveFailures: 0,
      createdBy: actor.createdBy,
      createdSessionId: actor.createdSessionId ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    store.repos.schedules.insert(task);
    emitTaskEvent(task, 'schedule.updated');
    onChanged?.();
    return task;
  }

  function update(id: string, raw: unknown): ScheduledTask {
    const patch = updateScheduledTaskInputSchema.parse(raw);
    const nowDate = clock();
    const nowIso = nowDate.toISOString();
    const updated = store.transaction(() => {
      const current = store.repos.schedules.get(id);
      if (patch.expectedUpdatedAt !== undefined && patch.expectedUpdatedAt !== current.updatedAt) {
        throw new AppError('SCHEDULE_CONFLICT', '定时任务已被其他操作更新，请刷新后重试。', 409);
      }
      const nextSlug = patch.slug !== undefined ? patch.slug : current.slug;
      validateSlugUnique(current.projectId, nextSlug, current.id);
      const nextTargetMode = patch.targetMode ?? current.targetMode;
      const rawTargetSessionId =
        patch.targetSessionId !== undefined
          ? patch.targetSessionId
          : nextTargetMode === 'new'
            ? null
            : current.targetSessionId;
      const targetSessionId = validateTargetSession(
        current.projectId,
        nextTargetMode,
        rawTargetSessionId,
      );
      const nextMode = patch.mode ?? current.mode;
      const nextExecutionPreference: ScheduleExecutionPreference =
        patch.executionPreference !== undefined
          ? patch.executionPreference
          : nextMode === 'readonly'
            ? 'project-v1'
            : current.executionPreference;
      const nextApprovalMode =
        patch.approvalMode !== undefined
          ? patch.approvalMode
          : nextMode === 'readonly' || nextExecutionPreference === 'native-v1'
            ? null
            : current.approvalMode;
      const nextMaxSearchChargeFen =
        patch.maxSearchChargeFen !== undefined
          ? patch.maxSearchChargeFen
          : nextApprovalMode !== 'automatic'
            ? 0
            : current.maxSearchChargeFen;
      const nextAgentRevisionId =
        patch.agentRevisionId !== undefined ? patch.agentRevisionId : current.agentRevisionId;
      validatePolicyCombination(
        nextMode,
        nextExecutionPreference,
        nextApprovalMode,
        nextMaxSearchChargeFen,
        nextAgentRevisionId,
      );

      if (nextAgentRevisionId) agents.requireReady(current.projectId, nextAgentRevisionId);

      const nextTimeZone = validateTimeZone(patch.timeZone ?? current.timeZone);
      const timingChanged =
        (patch.timing !== undefined && !timingEquals(patch.timing, current.timing)) ||
        nextTimeZone !== current.timeZone;
      const nextTiming = timingChanged
        ? normalizeTiming(patch.timing ?? current.timing, nextTimeZone, nextTargetMode, nowDate)
        : current.timing;

      // Invariant: editing a paused or ended task never silently re-enables it unless status='active' is explicit.
      const nextStatus: ScheduleStatus = patch.status ?? current.status;
      const resuming = current.status !== 'active' && nextStatus === 'active';
      const pausing = nextStatus === 'paused';

      let nextRunAt = current.nextRunAt;
      if (nextTiming.kind === 'manual') {
        nextRunAt = null;
      } else if (resuming || (nextStatus === 'active' && timingChanged)) {
        nextRunAt = computeNextRunAt(nextTiming, nextTimeZone, nowDate, {
          lastRunAt: current.lastRunAt,
        });
        if (!nextRunAt) {
          throw new AppError(
            'SCHEDULE_INVALID_TIMING',
            '恢复或更新后的定时任务必须包含未来触发时刻。',
            400,
          );
        }
      } else if (nextStatus === 'paused' && timingChanged) {
        nextRunAt = computeNextRunAt(nextTiming, nextTimeZone, nowDate, {
          lastRunAt: current.lastRunAt,
        });
      }

      const nextTask: ScheduledTask = {
        ...current,
        slug: nextSlug,
        title: patch.title ?? current.title,
        prompt: patch.prompt ?? current.prompt,
        timing: nextTiming,
        timeZone: nextTimeZone,
        targetMode: nextTargetMode,
        targetSessionId,
        agentRevisionId: nextAgentRevisionId,
        model: patch.model !== undefined ? patch.model : current.model,
        effort: patch.effort !== undefined ? patch.effort : current.effort,
        mode: nextMode,
        executionPreference: nextExecutionPreference,
        approvalMode: nextApprovalMode,
        maxSearchChargeFen: nextMaxSearchChargeFen,
        timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeoutMs,
        misfirePolicy: patch.misfirePolicy ?? current.misfirePolicy,
        overlapPolicy: patch.overlapPolicy ?? current.overlapPolicy,
        notifyPolicy: patch.notifyPolicy ?? current.notifyPolicy,
        status: nextStatus,
        pauseReason: pausing
          ? (current.pauseReason ?? 'manual')
          : resuming
            ? null
            : current.pauseReason,
        consecutiveFailures: resuming ? 0 : current.consecutiveFailures,
        nextRunAt,
        updatedAt: nowIso,
      };
      return store.repos.schedules.update(nextTask);
    });
    emitTaskEvent(updated, 'schedule.updated');
    onChanged?.();
    return updated;
  }

  function remove(id: string): void {
    const existing = store.repos.schedules.get(id);
    store.repos.schedules.remove(id);
    emitTaskEvent(existing, 'schedule.updated');
    onChanged?.();
  }

  function issueTriggerToken(id: string): { task: ScheduledTask; token: string } {
    store.repos.schedules.get(id);
    const token = `atk_${randomBytes(32).toString('base64url')}`;
    const hash = hashTriggerToken(token);
    const nowIso = clock().toISOString();
    const task = store.repos.schedules.setTriggerToken(id, hash, true, nowIso);
    emitTaskEvent(task, 'schedule.updated');
    return { task, token };
  }

  function revokeTriggerToken(id: string): ScheduledTask {
    store.repos.schedules.get(id);
    const nowIso = clock().toISOString();
    const task = store.repos.schedules.setTriggerToken(id, null, false, nowIso);
    emitTaskEvent(task, 'schedule.updated');
    return task;
  }

  function verifyTriggerToken(idOrSlug: string, rawToken: string): ScheduledTask | null {
    const trimmed = rawToken.trim();
    if (!trimmed) return null;
    let task: ScheduledTask | undefined;
    try {
      task = store.repos.schedules.findByIdOrSlug(idOrSlug);
    } catch {
      return null;
    }
    if (!task) return null;
    const auth = store.repos.schedules.getTriggerAuth(task.id);
    if (!auth?.remoteTriggerEnabled || !auth.triggerTokenHash) return null;
    const providedHash = hashTriggerToken(trimmed);
    if (!safeHashEqual(auth.triggerTokenHash, providedHash)) return null;
    return task;
  }

  function pauseForArchivedSession(sessionId: string): void {
    const tasks = store.repos.schedules.listByTargetSession(sessionId);
    const nowIso = clock().toISOString();
    let changed = false;
    for (const task of tasks) {
      if (task.status !== 'active') continue;
      const paused: ScheduledTask = {
        ...task,
        status: 'paused',
        pauseReason: 'target_archived',
        updatedAt: nowIso,
      };
      store.repos.schedules.update(paused);
      emitTaskEvent(paused, 'schedule.updated');
      changed = true;
    }
    if (changed) onChanged?.();
  }

  function pauseForDeletedSession(sessionId: string): void {
    const tasks = store.repos.schedules.listByTargetSession(sessionId);
    const nowIso = clock().toISOString();
    let changed = false;
    for (const task of tasks) {
      const updated: ScheduledTask = {
        ...task,
        targetSessionId: null,
        status: task.status === 'active' ? 'paused' : task.status,
        pauseReason: task.status === 'active' ? 'target_deleted' : task.pauseReason,
        updatedAt: nowIso,
      };
      store.repos.schedules.update(updated);
      emitTaskEvent(updated, 'schedule.updated');
      changed = true;
    }
    if (changed) onChanged?.();
  }

  return {
    list,
    get,
    resolve,
    listRuns,
    getRun,
    create,
    update,
    remove,
    issueTriggerToken,
    revokeTriggerToken,
    verifyTriggerToken,
    pauseForArchivedSession,
    pauseForDeletedSession,
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
