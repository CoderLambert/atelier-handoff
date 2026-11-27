/**
 * @file 统一解析 SDK 任务帧并维护单一前台工具与后台交接协调视图。
 * @implementation 共享 local_agent 与 local_bash 的 task_started/task_updated/task_notification 帧校验，集中持有活跃工具表与前台/后台判定。
 * @updated 2026-11-27T21:25:00+08:00
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import type { BashTaskReceipt, NativeBashTasks } from '../../native-bash.js';
import type { SubagentRun } from '../../subagent-run.js';

export const sdkTaskIdentifierSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
export const sdkTaskTerminalStatusSchema = z.enum(['completed', 'failed', 'stopped']);
export const sdkTaskRestartReasonSchema = z.literal('worker_restart');
export const sdkTaskBackgroundPatchSchema = z.object({ is_backgrounded: z.literal(true) });

function createSdkTaskFrameSchemas<Id extends z.ZodString>(idSchema: Id) {
  const base = z.object({
    session_id: idSchema,
    task_id: idSchema,
    run_id: idSchema.optional(),
    tool_use_id: idSchema.optional(),
  });
  return {
    base,
    updated: base.extend({ patch: sdkTaskBackgroundPatchSchema }),
    terminal: base.extend({
      status: sdkTaskTerminalStatusSchema,
      reason: sdkTaskRestartReasonSchema.optional(),
      summary: z.string(),
    }),
  };
}

const agentBaseFrames = createSdkTaskFrameSchemas(z.string());
export const agentTaskFrames = {
  ...agentBaseFrames,
  started: agentBaseFrames.base.extend({
    task_type: z.literal('local_agent'),
    parent_task_id: z.undefined().optional(),
    is_backgrounded: z.boolean().optional(),
  }),
};

const bashBaseFrames = createSdkTaskFrameSchemas(sdkTaskIdentifierSchema);
export const bashTaskFrames = {
  ...bashBaseFrames,
  started: bashBaseFrames.base.extend({
    task_type: z.literal('local_bash'),
    is_backgrounded: z.boolean().optional(),
    parent_task_id: sdkTaskIdentifierSchema.optional(),
  }),
  terminal: bashBaseFrames.terminal.extend({
    output_file: z.string().max(4096),
  }),
};

export interface RunningToolEntry {
  useId?: string;
  subagentId?: string;
}

export type TaskBackgroundControl = Pick<Query, 'backgroundTasks' | 'stopTask'>;

type SubagentTaskSlice = Pick<
  SubagentRun,
  'active' | 'hasBackground' | 'isBackground' | 'canMove' | 'moveToBackground'
>;
type BashTaskSlice = Pick<
  NativeBashTasks,
  'hasDeferredReceipt' | 'isBackground' | 'canMove' | 'control'
>;
type SubagentFrameConsumer = SubagentTaskSlice &
  Pick<SubagentRun, 'started' | 'updated' | 'notify'>;
type BashFrameConsumer = BashTaskSlice & Pick<NativeBashTasks, 'started' | 'updated' | 'terminal'>;

export interface SdkTaskCoordinationView {
  readonly hasBash: boolean;
  readonly hasActiveSubagents: boolean;
  readonly hasDeferredWork: boolean;
  foregroundTools(): string[];
  isForeground(id: string): boolean;
  canBackground(id: string): boolean;
  backgroundTool(sdk: TaskBackgroundControl, id: string): Promise<void>;
}

/** Creates the narrow foreground/background coordination view shared with LiveTurnCoordinator. */
export function createTaskCoordinationView(options: {
  runningTools: ReadonlyMap<string, RunningToolEntry>;
  subagents: SubagentTaskSlice;
  bash?: BashTaskSlice;
}): SdkTaskCoordinationView {
  const { runningTools, subagents, bash } = options;

  function isForeground(id: string): boolean {
    const entry = runningTools.get(id);
    return Boolean(
      entry && !entry.subagentId && !bash?.isBackground(id) && !subagents.isBackground(id),
    );
  }

  function foregroundTools(): string[] {
    return [...runningTools]
      .filter(
        ([id, { subagentId }]) =>
          !subagentId && !bash?.isBackground(id) && !subagents.isBackground(id),
      )
      .map(([id]) => id);
  }

  function canBackground(id: string): boolean {
    const useId = runningTools.get(id)?.useId;
    if (!useId || !(subagents.canMove(id) || bash?.canMove(id))) return false;
    let count = 0;
    for (const call of runningTools.values()) {
      if (call.useId === useId) count++;
    }
    return count === 1;
  }

  async function backgroundTool(sdk: TaskBackgroundControl, id: string): Promise<void> {
    if (!canBackground(id))
      throw new AppError('LIVE_INPUT_UNAVAILABLE', '当前运行无法插入消息。', 409);
    if (subagents.canMove(id)) await subagents.moveToBackground(sdk, id);
    else if (bash) await bash.control(sdk, id, 'background');
  }

  return {
    get hasBash() {
      return Boolean(bash);
    },
    get hasActiveSubagents() {
      return subagents.active;
    },
    get hasDeferredWork() {
      return Boolean(bash?.hasDeferredReceipt || subagents.hasBackground);
    },
    foregroundTools,
    isForeground,
    canBackground,
    backgroundTool,
  };
}

/** Coordinates SDK task frames and owns the single live tool registry for a run. */
export class SdkTaskCoordinator implements SdkTaskCoordinationView {
  private readonly activeTools = new Map<string, RunningToolEntry>();
  private readonly view: SdkTaskCoordinationView;

  constructor(
    private readonly subagents: SubagentFrameConsumer,
    private readonly bash?: BashFrameConsumer,
  ) {
    this.view = createTaskCoordinationView({
      runningTools: this.activeTools,
      subagents,
      bash,
    });
  }

  get runningTools(): ReadonlyMap<string, RunningToolEntry> {
    return this.activeTools;
  }

  get hasBash() {
    return this.view.hasBash;
  }

  get hasActiveSubagents() {
    return this.view.hasActiveSubagents;
  }

  get hasDeferredWork() {
    return this.view.hasDeferredWork;
  }

  trackTool(id: string, entry: RunningToolEntry): void {
    this.activeTools.set(id, entry);
  }

  untrackTool(id: string): void {
    this.activeTools.delete(id);
  }

  foregroundTools(): string[] {
    return this.view.foregroundTools();
  }

  isForeground(id: string): boolean {
    return this.view.isForeground(id);
  }

  canBackground(id: string): boolean {
    return this.view.canBackground(id);
  }

  backgroundTool(sdk: TaskBackgroundControl, id: string): Promise<void> {
    return this.view.backgroundTool(sdk, id);
  }

  handleStarted(frame: unknown): void {
    const taskType =
      typeof frame === 'object' && frame !== null && 'task_type' in frame
        ? frame.task_type
        : undefined;
    if (taskType === 'local_agent') {
      this.subagents.started(frame);
      return;
    }
    if (taskType === 'local_bash') {
      this.bash?.started(frame);
      return;
    }
    this.subagents.started(frame);
    this.bash?.started(frame);
  }

  handleUpdated(frame: unknown): void {
    this.subagents.updated(frame);
    this.bash?.updated(frame);
  }

  handleNotification(frame: unknown): {
    subagentFinished: boolean;
    bashReceipt?: BashTaskReceipt;
  } {
    const subagentFinished = this.subagents.notify(frame);
    const bashReceipt = this.bash?.terminal(frame);
    return { subagentFinished, bashReceipt };
  }
}
