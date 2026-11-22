/**
 * @file 管理一轮原生 Agent SDK 子进程及可观察的 Linux 后代的停止与收尾。
 * @implementation 独立 session 隔离每轮进程，按 /proc stat 身份追踪后代；保留 SDK EOF 宽限后有界升级信号并报告残留。
 * @updated 2026-11-22T12:00:00+08:00
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

export interface HarnessProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface HarnessProcessIssue {
  operation: 'observe' | 'signal' | 'spawn' | 'callback';
  code: string;
  pid?: number;
}

export interface HarnessProcessCleanup {
  containment: 'linux-session' | 'child-only';
  /** An exit event (or failure to spawn) was observed; sending a signal alone is not exit. */
  rootExited: boolean;
  exit: HarnessProcessExit | null;
  escalated: boolean;
  stderrBytes: number;
  /** Live observed processes remaining at the deadline. Zombies cannot run and are excluded. */
  remainingPids: number[];
  issues: HarnessProcessIssue[];
}

export interface HarnessProcessOptions {
  /** Pass this same controller to query({ options: { abortController } }). */
  abortController?: AbortController;
  /** Includes the locked SDK 0.3.326's 2 s EOF grace and subsequent 5 s escalation. */
  gracefulTimeoutMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
  observeIntervalMs?: number;
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
  onExit?: (exit: HarnessProcessExit) => void;
  onError?: (error: Error) => void;
}

export interface HarnessProcess {
  readonly abortController: AbortController;
  readonly child: ChildProcessWithoutNullStreams | undefined;
  /** One instance owns exactly one spawn. The signature is the locked SDK's public hook. */
  spawnClaudeCodeProcess(options: SpawnOptions): ChildProcessWithoutNullStreams;
  /** Abort the SDK and wait for the same cleanup barrier used by normal completion. */
  stop(): Promise<HarnessProcessCleanup>;
  /** Await in agent.ts's finally, BEFORE publishing a terminal run status. */
  cleanup(): Promise<HarnessProcessCleanup>;
}

interface ProcessStat {
  pid: number;
  parent: number;
  group: number;
  session: number;
  start: string;
  state: string;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string')
    return error.code;
  return error instanceof Error ? error.name : 'UNKNOWN';
}

function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError('Process lifecycle durations must be positive integer milliseconds.');
  return result;
}

function parseStat(text: string, pid: number): ProcessStat | undefined {
  // comm can contain spaces, parentheses and newlines. The fields follow its LAST closing ')'.
  const end = text.lastIndexOf(') ');
  if (end < 0 || !text.startsWith(`${pid} (`)) return;
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  const start = fields[19]; // /proc/<pid>/stat field 22, measured in ticks since boot.
  if (
    !state ||
    !/^[A-Za-z]$/.test(state) ||
    !Number.isSafeInteger(parent) ||
    parent < 0 ||
    !Number.isSafeInteger(group) ||
    group < 0 ||
    !Number.isSafeInteger(session) ||
    session < 0 ||
    !start ||
    !/^\d+$/.test(start)
  )
    return;
  return { pid, parent, group, session, start, state };
}

function sameProcess(left: ProcessStat, right: ProcessStat): boolean {
  return left.pid === right.pid && left.start === right.start;
}

function running(stat: ProcessStat): boolean {
  return stat.state !== 'Z' && stat.state !== 'X' && stat.state !== 'x';
}

/**
 * Linux uses only Node builtins and /proc; no systemd user bus, cgroup delegation, external
 * kill command, Python or unpacked helper is assumed in an installed build.
 *
 * This is lifecycle cleanup, not a security sandbox. The SDK session remains discoverable
 * after its leader exits. Descendants observed moving into other sessions stay tracked by
 * (pid, starttime). A process which double-forks AND starts a new session between samples
 * can escape observation. Node does not expose subreaper/pidfd syscalls: stat checks before
 * each individual signal reduce PID-reuse hazards but cannot make check-and-kill atomic.
 * No command-name matching, host process-group kill, or unverified saved PID is used.
 * Non-Linux cleanup covers the direct child only; do not advertise tree containment there.
 */
export function createHarnessProcess(options: HarnessProcessOptions = {}): HarnessProcess {
  const abortController = options.abortController ?? new AbortController();
  const gracefulTimeout = duration(options.gracefulTimeoutMs, 8_000);
  const terminateTimeout = duration(options.terminateTimeoutMs, 1_000);
  const killTimeout = duration(options.killTimeoutMs, 1_000);
  const observeInterval = duration(options.observeIntervalMs, 100);
  const linux = process.platform === 'linux';
  const known = new Map<number, ProcessStat>();
  const issues = new Map<string, HarnessProcessIssue>();
  let child: ChildProcessWithoutNullStreams | undefined;
  let root: ProcessStat | undefined;
  let sessionClosed = false;
  let rootExited = false;
  let exit: HarnessProcessExit | null = null;
  let escalated = false;
  let stderrBytes = 0;
  let observation: ReturnType<typeof setInterval> | undefined;
  let cleanupPromise: Promise<HarnessProcessCleanup> | undefined;
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  function issue(operation: HarnessProcessIssue['operation'], error: unknown, pid?: number): void {
    const code = errorCode(error);
    issues.set(`${operation}:${code}:${pid ?? ''}`, {
      operation,
      code,
      ...(pid === undefined ? {} : { pid }),
    });
  }

  function callback(invoke: () => void): void {
    try {
      invoke();
    } catch (error) {
      issue('callback', error);
    }
  }

  function readStat(pid: number): ProcessStat | undefined {
    try {
      const stat = parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8'), pid);
      if (!stat) issue('observe', Object.assign(new Error(), { code: 'INVALID_PROC_STAT' }), pid);
      return stat;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(errorCode(error))) issue('observe', error, pid);
      return;
    }
  }

  function capture(full = false): ProcessStat[] {
    if (!linux || !root) return [];
    const snapshot = new Map<number, ProcessStat>();
    let complete = full;
    if (full) {
      try {
        for (const entry of readdirSync('/proc')) {
          if (!/^\d+$/.test(entry)) continue;
          const pid = Number(entry);
          if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
          const stat = readStat(pid);
          if (stat) snapshot.set(pid, stat);
        }
      } catch (error) {
        issue('observe', error);
        complete = false;
      }
    }
    if (!complete) {
      // Normal execution visits only proven processes and their per-thread child lists.
      // A whole-host scan on every timer tick would scale with unrelated host workloads.
      const queue: ProcessStat[] = [];
      for (const prior of known.values()) {
        const current = readStat(prior.pid);
        if (current && sameProcess(prior, current)) queue.push(current);
      }
      const visited = new Set<number>();
      for (let index = 0; index < queue.length; index++) {
        const parent = queue[index];
        if (!parent || visited.has(parent.pid)) continue;
        visited.add(parent.pid);
        snapshot.set(parent.pid, parent);
        try {
          // Linux assigns children to the thread which forked them, not necessarily the main TID.
          for (const thread of readdirSync(`/proc/${parent.pid}/task`)) {
            if (!/^\d+$/.test(thread)) continue;
            const path = `/proc/${parent.pid}/task/${thread}/children`;
            let children: string;
            try {
              children = readFileSync(path, 'utf8');
            } catch (error) {
              if (!['ENOENT', 'ESRCH'].includes(errorCode(error)))
                issue('observe', error, parent.pid);
              continue;
            }
            for (const id of children.trim().split(/\s+/)) {
              if (!/^\d+$/.test(id)) continue;
              const pid = Number(id);
              if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
              const childStat = readStat(pid);
              if (
                childStat &&
                childStat.parent === parent.pid &&
                BigInt(childStat.start) >= BigInt(parent.start)
              )
                queue.push(childStat);
            }
          }
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes(errorCode(error))) issue('observe', error, parent.pid);
        }
      }
    }
    const currentRoot = snapshot.get(root.pid);
    // A reused session-leader PID is never authority to claim its new session.
    if (currentRoot && !sameProcess(root, currentRoot)) sessionClosed = true;
    const owned = new Map<number, ProcessStat>();
    for (const [pid, prior] of known) {
      const current = snapshot.get(pid);
      if (current && sameProcess(prior, current)) owned.set(pid, current);
    }
    if (!sessionClosed && complete) {
      let sessionMembers = 0;
      for (const stat of snapshot.values()) {
        if (stat.session === root.pid && BigInt(stat.start) >= BigInt(root.start)) {
          owned.set(stat.pid, stat);
          sessionMembers++;
        }
      }
      if (!sessionMembers) sessionClosed = true;
    }
    // Iterate to a fixed point: /proc enumeration order is unrelated to ancestry.
    let added: boolean;
    do {
      added = false;
      for (const stat of snapshot.values()) {
        if (!owned.has(stat.pid) && owned.has(stat.parent)) {
          owned.set(stat.pid, stat);
          added = true;
        }
      }
    } while (added);
    known.clear();
    for (const [pid, stat] of owned) known.set(pid, stat);
    return [...owned.values()].filter(running);
  }

  function signalOwned(signal: NodeJS.Signals): void {
    if (!child) return;
    if (!linux || !root) {
      if (
        !rootExited &&
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          if (child.kill(signal) && signal === 'SIGKILL') escalated = true;
        } catch (error) {
          issue('signal', error, child.pid);
        }
      }
      return;
    }
    // Descendants first lets a cooperative parent reap them. Never signal an inherited group:
    // a shell may have joined the host's group after being observed in our tree.
    const rootPid = root.pid;
    const targets = capture(true).sort((left, right) => {
      if (left.pid === rootPid) return 1;
      if (right.pid === rootPid) return -1;
      return right.pid - left.pid;
    });
    for (const prior of targets) {
      const current = readStat(prior.pid);
      if (!current || !sameProcess(prior, current) || !running(current)) continue;
      try {
        process.kill(prior.pid, signal);
        if (signal === 'SIGKILL') escalated = true;
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') issue('signal', error, prior.pid);
      }
    }
  }

  async function waitForExit(timeout: number): Promise<void> {
    if (rootExited || !child) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeout);
      }),
    ]);
    clearTimeout(timer);
  }

  function alive(): boolean {
    return (!rootExited && child !== undefined) || capture(true).length > 0;
  }

  async function waitForTree(timeout: number): Promise<void> {
    const deadline = performance.now() + timeout;
    while (alive()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(observeInterval, remaining)),
      );
    }
  }

  async function performCleanup(): Promise<HarnessProcessCleanup> {
    try {
      // Ending stdin is the SDK's own graceful close mechanism. The raw AbortSignal is
      // deliberately NOT passed to spawn: SDK SpawnOptions.signal is delayed until its grace.
      if (child && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      await waitForExit(gracefulTimeout);
      if (alive()) {
        signalOwned('SIGTERM');
        await waitForTree(terminateTimeout);
      }
      if (alive()) {
        signalOwned('SIGKILL');
        await waitForTree(killTimeout);
      }
      const remainingPids = capture(true).map((stat) => stat.pid);
      if (child?.pid !== undefined && !rootExited && !remainingPids.includes(child.pid))
        remainingPids.push(child.pid);
      return {
        containment: linux && root && root.session === root.pid ? 'linux-session' : 'child-only',
        rootExited: rootExited || !child,
        exit,
        escalated,
        stderrBytes,
        remainingPids,
        issues: [...issues.values()],
      };
    } finally {
      clearInterval(observation);
      abortController.signal.removeEventListener('abort', beginCleanup);
    }
  }

  function cleanup(): Promise<HarnessProcessCleanup> {
    // Defer execution so a simultaneous exit/abort cannot recursively start another cleanup.
    cleanupPromise ??= Promise.resolve().then(performCleanup);
    return cleanupPromise;
  }

  function beginCleanup(): void {
    void cleanup();
  }

  abortController.signal.addEventListener('abort', beginCleanup, { once: true });
  if (abortController.signal.aborted) beginCleanup();

  return {
    abortController,
    get child() {
      return child;
    },
    spawnClaudeCodeProcess(spawnOptions) {
      abortController.signal.throwIfAborted();
      if (child || cleanupPromise) throw new Error('A harness process owns exactly one SDK spawn.');
      child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        // This is the SDK's forwarded signal, not options.abortController.signal.
        signal: spawnOptions.signal,
        detached: linux,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (linux && child.pid !== undefined) {
        root = readStat(child.pid);
        if (root) known.set(root.pid, root);
        else
          issue(
            'observe',
            Object.assign(new Error(), { code: 'ROOT_IDENTITY_UNAVAILABLE' }),
            child.pid,
          );
        capture();
        observation = setInterval(capture, observeInterval);
        observation.unref();
      }
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
      });
      // ChildProcess emits errors for stdin EPIPE even when the SDK is already closing.
      child.stdin.on('error', () => {});
      child.once('exit', (code, signal) => {
        rootExited = true;
        exit = { code, signal };
        resolveExit();
        capture(true);
        callback(() => options.onExit?.({ code, signal }));
        beginCleanup();
      });
      child.on('error', (error) => {
        if (errorCode(error) !== 'ABORT_ERR') issue('spawn', error, child?.pid);
        callback(() => options.onError?.(error));
        // AbortError is not exit: a child can catch SIGTERM and remain alive.
        if (child?.pid === undefined) {
          rootExited = true;
          resolveExit();
          beginCleanup();
        }
      });
      callback(() => {
        if (child) options.onSpawn?.(child);
      });
      return child;
    },
    stop() {
      abortController.abort();
      return cleanup();
    },
    cleanup,
  };
}
