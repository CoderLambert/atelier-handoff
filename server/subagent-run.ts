/**
 * @file 管理父运行内的原生子代理派发与工具归属。
 * @implementation 由 SDK 调度同批前台委派，使用任务与调用标识关联进度，通过单次票据将身份传给本机工具。
 * @updated 2026-11-21T12:00:00+00:00
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { now, type Run } from '../shared/types.js';
import type { Subagent } from '../shared/subagents.js';
import type {
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
} from '@anthropic-ai/claude-agent-sdk';

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
type EndStatus = Exclude<Subagent['status'], 'running'>;
interface Journal {
  startSubagent(value: Subagent): void;
  finishSubagent(id: string, runId: string, status: EndStatus, summary: string | null): void;
}
interface Task {
  kind: Subagent['kind'];
  title: string;
  taskId?: string;
  sdkRunId?: string;
}

export class SubagentRun {
  private readonly tasks = new Map<string, Task>();
  private readonly bySdkId = new Map<string, string>();
  private readonly tickets = new Map<
    string,
    { id: string; name: string; hash: string; subagentId?: string }
  >();

  constructor(
    private readonly run: Run,
    private readonly journal: Journal,
    private readonly onFinish?: (id: string) => void,
  ) {}

  get active() {
    return this.tasks.size > 0;
  }

  reserve(id: string, input: unknown) {
    const args = dispatchSchema.strict().parse(input);
    if (this.tasks.has(id)) throw new Error('子任务已分配。');
    this.tasks.set(id, { kind: agentKinds[args.subagent_type], title: args.description });
    return { ...args, run_in_background: false };
  }

  started(message: SDKTaskStartedMessage) {
    if (!message.tool_use_id || message.task_type !== 'local_agent') return;
    const id = `${this.run.id}:${message.tool_use_id}`;
    const task = this.tasks.get(id);
    if (!task || task.taskId || this.bySdkId.has(message.task_id)) return;
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

  notify(message: SDKTaskNotificationMessage) {
    const id = this.bySdkId.get(message.task_id);
    const task = id ? this.tasks.get(id) : undefined;
    if (!id || !task || task.sdkRunId !== message.run_id) return;
    // Native foreground results include the report. Do not replace it with a generic completion notification.
    if (message.status !== 'completed')
      this.finish(id, message.status === 'stopped' ? 'stopped' : 'failed', message.summary);
  }

  report(id: string, output: unknown) {
    const report = reportSchema.safeParse(output);
    if (!report.success) return false;
    const summary = report.data.content
      .map(({ text }) =>
        text
          .replace(/^<tools-used-before-summary>[^<]*<\/tools-used-before-summary>\s*/, '')
          .trim(),
      )
      .filter(Boolean)
      .join('\n\n');
    this.finish(id, 'completed', summary || null);
    return true;
  }

  finish(id: string, status: EndStatus, summary: string | null) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.taskId) {
      this.journal.finishSubagent(id, this.run.id, status, summary?.slice(0, 16_000) ?? null);
      this.bySdkId.delete(task.taskId);
    }
    this.onFinish?.(id);
    this.tasks.delete(id);
    this.dropToolTickets(id);
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
