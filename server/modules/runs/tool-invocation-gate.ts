/**
 * @file 提供工具一次性调用票据门禁与项目目录写操作串行锁。
 * @implementation 按工具名称与规范化参数哈希签发并一次性核销 MCP 票据，随子代理结束吊销挂起票据，并按工作目录串行化获批后的写入副作用。
 * @updated 2026-11-27T19:48:00+08:00
 */
import { randomUUID } from 'node:crypto';
import { fingerprint } from '../../files.js';

export interface ToolTicketEntry {
  id: string;
  name: string;
  hash: string;
  subagentId?: string;
}

export function callHash(name: string, args: Record<string, unknown>): string {
  return fingerprint(
    JSON.stringify(
      name === 'mcp__atelier__list_files' ? { ...args, path: args.path ?? '' } : args,
      (_key, value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
    ),
  );
}

/** Issues and verifies one-time tickets binding PreToolUse hooks to MCP tool handlers. */
export class ToolInvocationGate {
  private readonly tickets = new Map<string, ToolTicketEntry>();

  constructor(private readonly isActorActive: (subagentId: string) => boolean = () => true) {}

  issue(id: string, name: string, args: Record<string, unknown>, subagentId?: string): string {
    const ticket = randomUUID();
    this.tickets.set(ticket, { id, name, hash: callHash(name, args), subagentId });
    return ticket;
  }

  claim(ticket: unknown, name: string, args: Record<string, unknown>): ToolTicketEntry | undefined {
    if (typeof ticket !== 'string') return undefined;
    const entry = this.tickets.get(ticket);
    if (!entry || entry.name !== name || entry.hash !== callHash(name, args)) return undefined;
    this.tickets.delete(ticket);
    if (!entry.subagentId || this.isActorActive(entry.subagentId)) return entry;
    return undefined;
  }

  revokeForActor(subagentId: string): void {
    for (const [ticket, entry] of this.tickets) {
      if (entry.subagentId === subagentId) this.tickets.delete(ticket);
    }
  }

  clear(): void {
    this.tickets.clear();
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
