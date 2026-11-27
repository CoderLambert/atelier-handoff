/**
 * @file 管理父运行内的原生子代理派发、分支中止信号与工具归属。
 * @implementation 本机信任沿用 SDK 前后台选择；复用统一 SDK 任务帧 schema 核对启动、交接和终态，并将分支 AbortController 生命周期收归任务本身。
 * @updated 2026-11-27T19:48:00+08:00
 */
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Subagent } from '../shared/subagents.js';
import { AppError, now, type Run } from '../shared/types.js';
import { agentTaskFrames } from './modules/runs/sdk-task-coordinator.js';

export { ProjectWrites } from './modules/runs/tool-invocation-gate.js';

export const agentKinds = { 'atelier-explore': 'explore', 'atelier-worker': 'worker' } as const;
const dispatchSchema = z.object({
  description: z.string().trim().min(1).max(180),
  prompt: z.string().trim().min(1).max(20_000),
  subagent_type: z.enum(['atelier-explore', 'atelier-worker']),
  run_in_background: z.boolean().optional(),
});
const reportSchema = z.object({
  status: z.literal('completed'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});
const handoffSchema = z.object({ status: z.literal('async_launched'), agentId: z.string() });
type EndStatus = Exclude<Subagent['status'], 'running'>;
type TaskFrame = z.infer<typeof agentTaskFrames.base>;
type Terminal = z.infer<typeof agentTaskFrames.terminal>;

interface Journal {
  startSubagent(value: Subagent): void;
  finishSubagent(id: string, runId: string, status: EndStatus, summary: string | null): void;
}
interface Task {
  kind: Subagent['kind'];
  title: string;
  toolUseId: string;
  taskId?: string;
  sdkRunId?: string;
  background?: boolean;
  handoffAgentId?: string;
  terminal?: Terminal;
  moveRejected?: boolean;
  controller?: AbortController;
}

export class SubagentRun {
  private readonly tasks = new Map<string, Task>();
  private readonly bySdkId = new Map<string, string>();

  constructor(
    private readonly run: Pick<Run, 'id' | 'sessionId'>,
    private readonly sdkSessionId: string,
    private readonly native: boolean,
    private readonly journal: Journal,
    private readonly onFinish: (id: string, status: EndStatus, summary: string | null) => void,
  ) {}

  get active() {
    return this.tasks.size > 0;
  }

  get hasBackground() {
    return [...this.tasks.values()].some((task) => task.background);
  }

  isActive(id: string): boolean {
    return this.tasks.has(id);
  }

  isBackground(id: string) {
    return this.tasks.get(id)?.background === true;
  }

  branchSignal(id: string): AbortSignal | undefined {
    return this.tasks.get(id)?.controller?.signal;
  }

  ensureBranchSignal(id: string): AbortSignal {
    const task = this.tasks.get(id);
    if (!task) throw new Error('当前子任务身份无效或已结束。');
    task.controller ??= new AbortController();
    return task.controller.signal;
  }

  canMove(id: string) {
    const task = this.tasks.get(id);
    return this.native && !!task?.taskId && !task.background && !task.moveRejected;
  }

  async moveToBackground(sdk: Pick<Query, 'backgroundTasks'>, id: string) {
    const task = this.tasks.get(id);
    if (!task || task.background) return;
    const moved = await sdk.backgroundTasks(task.toolUseId);
    if (this.tasks.get(id) !== task) return;
    if (moved) task.background = true;
    else if (!task.background && !task.terminal) {
      task.moveRejected = true;
      throw new AppError('LIVE_INPUT_UNAVAILABLE', '当前运行无法插入消息。', 409);
    }
  }

  async stop(sdk: Pick<Query, 'stopTask'>, id: string): Promise<void> {
    const task = this.tasks.get(id);
    const sdkId = task?.taskId;
    if (!task || !sdkId) throw new AppError('SUBAGENT_NOT_ACTIVE', '子任务已结束或尚未就绪。', 409);
    // Abort workbench-owned approvals and commands independently of the parent run.
    task.controller ??= new AbortController();
    const stopping = sdk.stopTask(sdkId);
    task.controller.abort();
    await stopping;
  }

  reserve(id: string, toolUseId: string, input: unknown) {
    const args = dispatchSchema.strict().parse(input);
    if (!this.native && args.run_in_background) throw new Error('受控子代理只能在前台运行。');
    if (this.tasks.has(id)) throw new Error('子任务已分配。');
    this.tasks.set(id, {
      kind: agentKinds[args.subagent_type],
      title: args.description,
      toolUseId,
    });
    return this.native ? args : { ...args, run_in_background: false };
  }

  started(input: unknown) {
    const parsed = agentTaskFrames.started.safeParse(input);
    if (!parsed.success || parsed.data.session_id !== this.sdkSessionId) return;
    const message = parsed.data;
    if (!message.tool_use_id) return;
    const id = `${this.run.id}:${message.tool_use_id}`;
    const task = this.tasks.get(id);
    if (
      !task ||
      task.taskId ||
      task.toolUseId !== message.tool_use_id ||
      this.bySdkId.has(message.task_id)
    )
      return;
    this.journal.startSubagent({
      id,
      runId: this.run.id,
      sessionId: this.run.sessionId,
      kind: task.kind,
      title: task.title,
      status: 'running',
      summary: null,
      startedAt: now(),
      endedAt: null,
    });
    task.taskId = message.task_id;
    task.sdkRunId = message.run_id;
    this.bySdkId.set(message.task_id, id);
    if (this.native && message.is_backgrounded) task.background = true;
    if (task.handoffAgentId && task.handoffAgentId !== message.task_id)
      this.finish(id, 'failed', '子代理后台交接与当前任务不匹配。');
  }

  actor(sdkAgentId: string) {
    const id = this.bySdkId.get(sdkAgentId);
    const task = id ? this.tasks.get(id) : undefined;
    if (!id || !task) throw new Error('当前子任务身份无效或已结束。');
    return { id, kind: task.kind };
  }

  taskId(appTaskId: string): string | undefined {
    return this.tasks.get(appTaskId)?.taskId;
  }

  private matches(task: Task, message: TaskFrame) {
    return (
      message.session_id === this.sdkSessionId &&
      task.sdkRunId === message.run_id &&
      (message.tool_use_id === undefined || task.toolUseId === message.tool_use_id)
    );
  }

  updated(input: unknown) {
    if (!this.native) return;
    const parsed = agentTaskFrames.updated.safeParse(input);
    if (!parsed.success) return;
    const id = this.bySdkId.get(parsed.data.task_id);
    const task = id ? this.tasks.get(id) : undefined;
    if (task && this.matches(task, parsed.data)) task.background = true;
  }

  notify(input: unknown) {
    const parsed = agentTaskFrames.terminal.safeParse(input);
    if (!parsed.success) return false;
    const message = parsed.data;
    const id = this.bySdkId.get(message.task_id);
    const task = id ? this.tasks.get(id) : undefined;
    if (!id || !task || !this.matches(task, message)) return false;
    // Foreground completion is recorded from the Agent hook, which carries the full report.
    const terminal = (task.terminal ??= message);
    if (task.handoffAgentId === message.task_id || terminal.status !== 'completed')
      this.finishFromNotice(id, terminal);
    return true;
  }

  private finishFromNotice(id: string, terminal: Terminal) {
    this.finish(
      id,
      terminal.reason === 'worker_restart' ? 'interrupted' : terminal.status,
      terminal.summary,
    );
  }

  report(id: string, output: unknown) {
    const task = this.tasks.get(id);
    if (!task) return;
    const handoff = handoffSchema.safeParse(output);
    if (this.native && handoff.success) {
      const agentId = handoff.data.agentId;
      if (
        (task.taskId && task.taskId !== agentId) ||
        (task.handoffAgentId && task.handoffAgentId !== agentId)
      ) {
        this.finish(id, 'failed', '子代理后台交接与当前任务不匹配。');
        return;
      }
      task.background = true;
      task.handoffAgentId = agentId;
      if (task.terminal) this.finishFromNotice(id, task.terminal);
      return;
    }
    const report = reportSchema.safeParse(output);
    if (!report.success) {
      this.finish(id, 'failed', '子代理未返回已完成的报告。');
      return;
    }
    const summary = report.data.content
      .map(({ text }) =>
        text
          .replace(/^<tools-used-before-summary>[^<]*<\/tools-used-before-summary>\s*/, '')
          .trim(),
      )
      .filter(Boolean)
      .join('\n\n');
    this.finish(id, 'completed', summary || null);
  }

  finish(id: string, status: EndStatus, summary: string | null) {
    const task = this.tasks.get(id);
    if (!task) return;
    const preview = summary?.slice(0, 16_000) ?? null;
    if (task.taskId) {
      this.journal.finishSubagent(id, this.run.id, status, preview);
      this.bySdkId.delete(task.taskId);
    }
    this.tasks.delete(id);
    task.controller?.abort();
    this.onFinish(id, status, preview);
  }

  close(status: EndStatus, reason: string) {
    for (const id of [...this.tasks.keys()]) this.finish(id, status, reason);
  }
}
