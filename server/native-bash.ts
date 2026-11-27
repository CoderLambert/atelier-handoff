/**
 * @file 关联单次 SDK 运行的 Bash 调用与原生命令任务。
 * @implementation 复用统一 SDK 任务帧 schema 根据所属会话回执更新状态，并串行处理同一命令的后台和停止请求。
 * @updated 2026-11-27T19:48:00+08:00
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BashControl, BashExecution } from '../shared/bash-execution.js';
import { AppError, now } from '../shared/types.js';
import { bashTaskFrames, sdkTaskIdentifierSchema } from './modules/runs/sdk-task-coordinator.js';

const handoff = z.object({
  backgroundTaskId: sdkTaskIdentifierSchema,
  timedOutAfterMs: z.int().positive().optional(),
});
const stopInput = z.object({ task_id: sdkTaskIdentifierSchema });

type Frame = z.infer<typeof bashTaskFrames.base>;
type Action = BashControl['action'];
export type BashTaskReceipt = {
  id: string;
  useId: string;
  sdkActorId?: string;
  receipt: z.infer<typeof bashTaskFrames.terminal>;
  failure?: string;
};
type Call = {
  id: string;
  useId: string;
  subagentId?: string;
  sdkActorId?: string;
  taskId?: string;
  attempt?: string;
  execution: BashExecution;
  background: boolean;
  handedOff?: boolean;
  terminal?: BashTaskReceipt['receipt'];
  claimed?: boolean;
  stopFailure?: string;
  moveRejected?: boolean;
  control?: { action: Action; done: Promise<void> };
};

export class NativeBashTasks {
  private readonly calls = new Map<string, Call>();

  constructor(
    private readonly sdkSessionId: string,
    private readonly publish: (id: string, execution: BashExecution) => void,
  ) {}

  register(id: string, useId: string, subagentId?: string, sdkActorId?: string): BashExecution {
    const prior = this.calls.get(id);
    if (prior) return prior.execution;
    const execution: BashExecution = {
      phase: 'foreground',
      controllable: false,
      lastObservedAt: now(),
    };
    this.calls.set(id, { id, useId, subagentId, sdkActorId, execution, background: false });
    return execution;
  }

  private update(call: Call, phase = call.execution.phase, foregroundTimeoutMs?: number) {
    if (this.calls.get(call.id) !== call) return;
    call.execution = {
      ...call.execution,
      phase,
      controllable: !!call.taskId && phase !== 'stopping' && phase !== 'unknown',
      lastObservedAt: now(),
      ...(foregroundTimeoutMs === undefined ? {} : { foregroundTimeoutMs }),
    };
    this.publish(call.id, call.execution);
  }

  private owner(message: Frame) {
    if (message.session_id !== this.sdkSessionId) return undefined;
    return [...this.calls.values()].find(
      (call) =>
        call.taskId === message.task_id &&
        (call.attempt === undefined || call.attempt === message.run_id) &&
        (message.tool_use_id === undefined || call.useId === message.tool_use_id),
    );
  }

  started(input: unknown) {
    const result = bashTaskFrames.started.safeParse(input);
    if (!result.success || result.data.session_id !== this.sdkSessionId) return;
    const message = result.data;
    const call = [...this.calls.values()].find(
      (entry) => entry.useId === message.tool_use_id && entry.sdkActorId === message.parent_task_id,
    );
    if (
      !call ||
      (call.taskId && call.taskId !== message.task_id) ||
      (call.attempt && call.attempt !== message.run_id)
    )
      return;
    call.taskId = message.task_id;
    call.attempt = message.run_id;
    call.moveRejected = false;
    call.background ||= message.is_backgrounded === true;
    this.update(
      call,
      call.background && call.execution.phase !== 'stopping' ? 'background' : call.execution.phase,
    );
  }

  updated(input: unknown) {
    const result = bashTaskFrames.updated.safeParse(input);
    const call = result.success ? this.owner(result.data) : undefined;
    if (call) this.backgrounded(call);
  }

  private matchingCalls(useId: string) {
    return [...this.calls.values()].filter((entry) => entry.useId === useId);
  }

  progress(useId: string, sdkSessionId: string, taskId?: string) {
    if (sdkSessionId !== this.sdkSessionId) return;
    const matches = this.matchingCalls(useId);
    const call = taskId
      ? matches.find((entry) => entry.taskId === taskId)
      : matches.length === 1
        ? matches[0]
        : undefined;
    if (call) this.update(call);
  }

  private backgrounded(call: Call, timeout?: number) {
    call.background = true;
    this.update(call, call.execution.phase === 'stopping' ? 'stopping' : 'background', timeout);
  }

  handedOff(id: string, input: unknown) {
    const result = handoff.safeParse(input);
    if (!result.success) return false;
    const call = this.calls.get(id);
    if (call && (!call.taskId || call.taskId === result.data.backgroundTaskId)) {
      call.taskId = result.data.backgroundTaskId;
      call.handedOff = true;
      this.backgrounded(call, result.data.timedOutAfterMs);
      return { terminal: this.claimReceipt(call) };
    }
    return {};
  }

  // A foreground completion notice can precede the richer tool hook. Keep it
  // until the hook establishes that the SDK returned a background placeholder.
  private claimReceipt(call: Call): BashTaskReceipt | undefined {
    const receipt = call.terminal;
    if (
      !receipt ||
      call.claimed ||
      (!call.handedOff && receipt.status !== 'stopped' && call.stopFailure === undefined)
    )
      return undefined;
    call.claimed = true;
    return {
      id: call.id,
      useId: call.useId,
      sdkActorId: call.sdkActorId,
      receipt,
      failure: call.stopFailure,
    };
  }

  terminal(input: unknown) {
    const result = bashTaskFrames.terminal.safeParse(input);
    if (!result.success) return undefined;
    const call = this.owner(result.data);
    if (!call) return undefined;
    call.terminal ??= result.data;
    return this.claimReceipt(call);
  }

  deferFailureDuringStop(id: string, error: string) {
    const call = this.calls.get(id);
    if (!call || call.execution.phase !== 'stopping') return false;
    if (call.terminal && call.terminal.status !== 'stopped') return false;
    call.stopFailure = error;
    return true;
  }

  failureAfterRejectedStop(id: string) {
    const call = this.calls.get(id);
    return call?.execution.phase === 'foreground' ? call.stopFailure : undefined;
  }

  complete(id: string) {
    this.calls.delete(id);
  }

  isBackground(id: string) {
    return this.calls.get(id)?.background === true;
  }

  awaitingTerminal(id: string) {
    const call = this.calls.get(id);
    return !!call && (call.background || call.execution.phase === 'stopping');
  }

  get hasDeferredReceipt() {
    return [...this.calls.keys()].some((id) => this.awaitingTerminal(id));
  }

  canMove(id: string) {
    const call = this.calls.get(id);
    return (
      !!call &&
      !call.moveRejected &&
      call.execution.phase === 'foreground' &&
      !call.subagentId &&
      this.matchingCalls(call.useId).length === 1
    );
  }

  authorizesStop(input: unknown, subagentId?: string) {
    const result = stopInput.safeParse(input);
    return (
      result.success &&
      [...this.calls.values()].some(
        (call) =>
          call.taskId === result.data.task_id && (!subagentId || call.subagentId === subagentId),
      )
    );
  }

  async control(
    connection: Pick<Query, 'backgroundTasks' | 'stopTask'>,
    id: string,
    action: Action,
  ) {
    const call = this.calls.get(id);
    if (!call) throw new AppError('BASH_CONTROL_UNAVAILABLE', '命令尚未就绪或已经结束。', 409);
    if (call.control?.action === action) return call.control.done;
    if (action === 'stop' && call.execution.phase === 'stopping' && !call.control) return;
    if (call.control || call.execution.phase === 'stopping')
      throw new AppError('BASH_CONTROL_BUSY', '命令正在处理另一项操作。', 409);
    if (action === 'background' && call.background) return;
    const taskId = call.taskId;
    const done = (async () => {
      try {
        if (action === 'stop') {
          if (!taskId)
            throw new AppError('BASH_CONTROL_UNAVAILABLE', '命令尚无 SDK 任务标识。', 409);
          this.update(call, 'stopping');
          await connection.stopTask(taskId);
        } else {
          if (this.matchingCalls(call.useId).length !== 1)
            throw new AppError(
              'BASH_CONTROL_UNAVAILABLE',
              '存在重叠的 SDK 调用标识，无法单独转入后台。',
              409,
            );
          const moved = await connection.backgroundTasks(call.useId);
          if (moved) this.backgrounded(call);
          else if (this.calls.has(id) && !call.background)
            throw new AppError('BASH_CONTROL_UNAVAILABLE', '命令暂时无法转到后台。', 409);
        }
      } catch (error) {
        if (!this.calls.has(id)) return;
        if (action === 'background') call.moveRejected = true;
        this.update(call, call.background ? 'background' : 'foreground');
        if (error instanceof AppError) throw error;
        throw new AppError('BASH_CONTROL_UNCONFIRMED', 'SDK 未确认命令操作，请检查当前状态。', 409);
      }
    })();
    call.control = { action, done };
    try {
      await done;
    } finally {
      call.control = undefined;
    }
  }
}
