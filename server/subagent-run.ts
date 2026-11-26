/**
 * @file 管理父运行内的原生子代理派发与工具归属。
 * @implementation 由 SDK 调度同批前台委派，按任务与调用标识确认后台交接和终态。通过单次票据将分支身份传给本机工具。
 * @updated 2026-11-26T00:04:19+08:00
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, now, type Run } from '../shared/types.js';
import type { Subagent } from '../shared/subagents.js';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

export const agentKinds = { 'atelier-explore': 'explore', 'atelier-worker': 'worker' } as const;
const dispatchSchema = z.object({
  description: z.string().trim().min(1).max(180),
  prompt: z.string().trim().min(1).max(20_000),
  subagent_type: z.enum(['atelier-explore', 'atelier-worker']),
  run_in_background: z.literal(false).optional(),
});
const reportSchema = z.object({
  status: z.literal('completed'),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
});
const taskFrame = z.object({
  session_id: z.string(),
  task_id: z.string(),
  run_id: z.string().optional(),
  tool_use_id: z.string().optional(),
});
const startedFrame = taskFrame.extend({
  task_type: z.literal('local_agent'),
  parent_task_id: z.undefined().optional(),
});
const updatedFrame = taskFrame.extend({ patch: z.object({ is_backgrounded: z.literal(true) }) });
const terminalFrame = taskFrame.extend({
  status: z.enum(['completed', 'failed', 'stopped']),
  reason: z.literal('worker_restart').optional(),
  summary: z.string(),
});
const handoffSchema = z.object({ status: z.literal('async_launched'), agentId: z.string() });
type EndStatus = Exclude<Subagent['status'], 'running'>;
type Terminal = z.infer<typeof terminalFrame>;
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
  handedOff?: boolean;
  terminal?: Terminal;
  moveRejected?: boolean;
}

export class SubagentRun {
  private readonly tasks = new Map<string, Task>();
  private readonly bySdkId = new Map<string, string>();
  private readonly tickets = new Map<
    string,
    { id: string; name: string; hash: string; subagentId?: string }
  >();

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

  isBackground(id: string) {
    return this.tasks.get(id)?.background === true;
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

  reserve(id: string, toolUseId: string, input: unknown) {
    const args = dispatchSchema.strict().parse(input);
    if (this.tasks.has(id)) throw new Error('子任务已分配。');
    this.tasks.set(id, {
      kind: agentKinds[args.subagent_type],
      title: args.description,
      toolUseId,
    });
    return { ...args, run_in_background: false };
  }

  started(input: unknown) {
    const parsed = startedFrame.safeParse(input);
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

  private matches(task: Task, message: z.infer<typeof taskFrame>) {
    return (
      message.session_id === this.sdkSessionId &&
      task.sdkRunId === message.run_id &&
      (message.tool_use_id === undefined || task.toolUseId === message.tool_use_id)
    );
  }

  updated(input: unknown) {
    if (!this.native) return;
    const parsed = updatedFrame.safeParse(input);
    if (!parsed.success) return;
    const id = this.bySdkId.get(parsed.data.task_id);
    const task = id ? this.tasks.get(id) : undefined;
    if (task && this.matches(task, parsed.data)) task.background = true;
  }

  notify(input: unknown) {
    const parsed = terminalFrame.safeParse(input);
    if (!parsed.success) return false;
    const message = parsed.data;
    const id = this.bySdkId.get(message.task_id);
    const task = id ? this.tasks.get(id) : undefined;
    if (!id || !task || !this.matches(task, message)) return false;
    // Foreground completion is recorded from the Agent hook, which carries the full report.
    const terminal = (task.terminal ??= message);
    if (task.handedOff || terminal.status !== 'completed') this.finishFromNotice(id, terminal);
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
    if (this.native && handoff.success && task.taskId === handoff.data.agentId) {
      task.background = true;
      task.handedOff = true;
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
    this.dropToolTickets(id);
    this.onFinish(id, status, preview);
  }

  ticket(id: string, name: string, hash: string, subagentId?: string) {
    const ticket = randomUUID();
    this.tickets.set(ticket, { id, name, hash, subagentId });
    return ticket;
  }

  claim(ticket: unknown, name: string, hash: string) {
    if (typeof ticket !== 'string') return;
    const entry = this.tickets.get(ticket);
    if (!entry || entry.name !== name || entry.hash !== hash) return;
    this.tickets.delete(ticket);
    if (!entry.subagentId || this.tasks.has(entry.subagentId)) return entry;
  }

  dropToolTickets(subagentId: string) {
    for (const [ticket, entry] of this.tickets)
      if (entry.subagentId === subagentId) this.tickets.delete(ticket);
  }

  close(status: EndStatus, reason: string) {
    this.tickets.clear();
    for (const id of this.tasks.keys()) this.finish(id, status, reason);
  }
}

/** Acquired at execution time, after user approval. Held until the actual side effect settles. */
export class ProjectWrites {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(
    verify: () => void | Promise<void>,
    effect: () => Promise<T>,
    directory = '',
  ): Promise<T> {
    const previous = this.tails.get(directory);
    let unlock: () => void = () => {};
    const tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.tails.set(directory, tail);
    try {
      await previous;
      await verify();
      return await effect();
    } finally {
      if (this.tails.get(directory) === tail) this.tails.delete(directory);
      unlock();
    }
  }
}
