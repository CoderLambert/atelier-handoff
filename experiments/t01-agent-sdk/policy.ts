import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type Emit = (type: string, data: Record<string, unknown>) => void;
export type Decision = 'allowed' | 'denied' | 'canceled' | 'expired';
export interface Operation {
  id: string;
  name: 'Write' | 'Edit';
  input: Record<string, unknown>;
  inputHash: string;
  path: string;
  before: string | null;
  after: string;
  beforeHash: string | null;
  afterHash: string;
}

// These are fixture boundaries, not an OS sandbox or an atomic file-apply layer.
export class ProjectPaths {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  async check(value: unknown, creating = false): Promise<string> {
    if (typeof value !== 'string' || !value || value.includes('\0') || value.startsWith('~') || value.split(/[\\/]/).includes('..')) throw new Error('INVALID_PATH');
    if (await realpath(this.root) !== this.root) throw new Error('ROOT_LINK');
    const target = resolve(this.root, value);
    const part = relative(this.root, target);
    if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('OUTSIDE_WORKSPACE');
    const parts = part.split(sep);
    let cursor = this.root;
    for (const [index, segment] of parts.entries()) {
      cursor = resolve(cursor, segment);
      let info;
      try { info = await lstat(cursor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && creating && index === parts.length - 1) return target;
        throw new Error('PATH_MISSING');
      }
      if (info.isSymbolicLink()) throw new Error('SYMLINK');
      if (index < parts.length - 1) {
        if (!info.isDirectory()) throw new Error('PARENT_NOT_DIRECTORY');
      } else if (!info.isFile() || info.nlink !== 1 || info.size > 32_768) throw new Error('UNSUPPORTED_FILE');
    }
    if (await realpath(target) !== target) throw new Error('PHYSICAL_PATH_CHANGED');
    return target;
  }
}

export class ApprovalGate {
  state: 'pending' | Decision = 'pending';
  readonly promise: Promise<Decision>;
  private finish!: (value: Decision) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly abort = () => this.settle('canceled');
  constructor(private readonly signal: AbortSignal, milliseconds = 15_000) {
    this.promise = new Promise(resolve => { this.finish = resolve; });
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.settle('canceled');
    else this.timer = setTimeout(() => this.settle('expired'), milliseconds);
  }
  settle(value: Decision): boolean {
    if (this.state !== 'pending') return false;
    // A cancellation wins even if an allow arrives in the same event-loop turn.
    this.state = this.signal.aborted ? 'canceled' : value;
    clearTimeout(this.timer);
    this.signal.removeEventListener('abort', this.abort);
    this.finish(this.state);
    return true;
  }
}

export class ToolPolicy {
  private readonly paths: ProjectPaths;
  private readonly snapshots = new Map<string, Operation>();
  private readonly seen = new Set<string>();
  readonly operations: Operation[] = [];
  readonly decisions: { id: string; decision: Decision | 'stale'; sdkAborted: boolean; appAborted: boolean }[] = [];
  constructor(
    root: string,
    private readonly tools: string[],
    private readonly cancellation: AbortSignal,
    private readonly emit: Emit,
    private readonly decide: (operation: Operation, gate: ApprovalGate) => void | Promise<void>,
  ) { this.paths = new ProjectPaths(root); }

  private async validate(name: string, input: Record<string, unknown>): Promise<string> {
    this.cancellation.throwIfAborted();
    if (!this.tools.includes(name) || !['Read', 'Write', 'Edit'].includes(name)) throw new Error('TOOL_NOT_ENABLED');
    const target = await this.paths.check(input.file_path, name === 'Write');
    this.cancellation.throwIfAborted();
    return target;
  }

  private async snapshot(name: 'Write' | 'Edit', input: Record<string, unknown>, id: string, target: string): Promise<Operation> {
    let before: string | null;
    try { before = await readFile(target, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && name === 'Write') before = null; else throw error; }
    let after: string;
    if (name === 'Write') {
      if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 8192) throw new Error('INVALID_CONTENT');
      after = input.content;
    } else {
      if (before === null || typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string' || Buffer.byteLength(input.new_string) > 8192 || (input.replace_all !== undefined && typeof input.replace_all !== 'boolean')) throw new Error('INVALID_EDIT');
      const matches = before.split(input.old_string).length - 1;
      if (!matches || (!input.replace_all && matches !== 1)) throw new Error('AMBIGUOUS_EDIT');
      after = input.replace_all ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string as string);
    }
    return { id, name, input: structuredClone(input), inputHash: hash(JSON.stringify(input)), path: relative(this.paths.root, target), before, after, beforeHash: before === null ? null : hash(before), afterHash: hash(after) };
  }

  preToolUse: HookCallback = async (event, _id, { signal }) => {
    const result = (permissionDecision: 'allow' | 'deny' | 'ask', reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision, permissionDecisionReason: reason } });
    try {
      signal.throwIfAborted();
      if (event.hook_event_name !== 'PreToolUse' || !event.tool_input || typeof event.tool_input !== 'object' || Array.isArray(event.tool_input)) throw new Error('INVALID_HOOK_INPUT');
      if (await realpath(event.cwd) !== this.paths.root) throw new Error('CWD_CHANGED');
      const input = event.tool_input as Record<string, unknown>;
      const target = await this.validate(event.tool_name, input);
      signal.throwIfAborted(); this.cancellation.throwIfAborted();
      if (this.seen.has(event.tool_use_id)) throw new Error('DUPLICATE_TOOL_ID');
      this.seen.add(event.tool_use_id);
      this.emit('guard.checked', { id: event.tool_use_id, tool: event.tool_name, path: relative(this.paths.root, target) });
      if (event.tool_name === 'Read') return result('allow', 'Read inside the dedicated test workspace.');
      const operation = await this.snapshot(event.tool_name as 'Edit' | 'Write', input, event.tool_use_id, target);
      signal.throwIfAborted(); this.cancellation.throwIfAborted();
      this.snapshots.set(operation.id, operation);
      return result('ask', 'Single-operation approval required.');
    } catch (error) {
      this.emit('guard.denied', { reason: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'GUARD_ERROR' });
      return result('deny', 'Tool or path not permitted, invalid operation, or canceled.');
    }
  };

  canUseTool: CanUseTool = async (name, input, { signal, toolUseID }) => {
    const deny = () => ({ behavior: 'deny' as const, message: 'This test operation was denied, canceled, expired, or changed. Do not retry or use another tool.' });
    const operation = this.snapshots.get(toolUseID);
    this.snapshots.delete(toolUseID);
    if (!operation || operation.name !== name || operation.inputHash !== hash(JSON.stringify(input))) return deny();
    const combined = AbortSignal.any([signal, this.cancellation]);
    let decision: Decision | 'stale' = 'denied';
    try {
      combined.throwIfAborted();
      await this.validate(name, input);
      combined.throwIfAborted();
      this.operations.push(operation);
      const gate = new ApprovalGate(combined);
      this.emit('permission.pending', { id: operation.id, tool: name, path: operation.path, beforeHash: operation.beforeHash, afterHash: operation.afterHash, preview: { before: operation.before, after: operation.after } });
      void Promise.resolve().then(() => this.decide(operation, gate)).catch(() => gate.settle('denied'));
      decision = await gate.promise;
      combined.throwIfAborted();
      if (decision !== 'allowed') return deny();
      const target = await this.validate(name, input);
      let current: string | null;
      try { current = hash(await readFile(target)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = null; else throw error; }
      combined.throwIfAborted();
      if (current !== operation.beforeHash) { decision = 'stale'; return deny(); }
      return { behavior: 'allow', updatedInput: structuredClone(operation.input) };
    } catch { decision = combined.aborted ? 'canceled' : 'denied'; return deny(); }
    finally {
      const evidence = { id: toolUseID, decision, sdkAborted: signal.aborted, appAborted: this.cancellation.aborted };
      this.decisions.push(evidence); this.emit('permission.resolved', evidence);
    }
  };
}
