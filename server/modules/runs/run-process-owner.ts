/**
 * @file 管理每轮 Claude Agent SDK 子进程的启动、退出和收尾。
 * @implementation 原生模式委托 Harness 跟踪进程归属，受控模式维护单进程退出屏障、取消升级和退出轨迹。
 * @updated 2026-11-27T18:09:00+08:00
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { createHarnessProcess } from '../../harness-process.js';

interface RunProcessOwnerOptions {
  native: boolean;
  abortController: AbortController;
  event: (
    type: 'process.spawned' | 'process.exited' | 'process.cleanup' | 'sdk.error',
    payload: Record<string, unknown>,
  ) => void;
  cancelTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

interface RunProcessOwner {
  spawnClaudeCodeProcess(options: SpawnOptions): ChildProcessWithoutNullStreams;
  cleanup(): Promise<{ cleanupUncertain: boolean; failure?: string }>;
}

export function createRunProcessOwner({
  native,
  abortController,
  event,
  cancelTimeoutMs = 1_000,
  cleanupTimeoutMs = 8_000,
}: RunProcessOwnerOptions): RunProcessOwner {
  const { signal } = abortController;
  if (native) {
    const harness = createHarnessProcess({
      abortController,
      onSpawn: (child) => event('process.spawned', { pid: child.pid ?? null }),
      onExit: ({ code, signal }) => event('process.exited', { code, signal }),
      onError: (error) => {
        if (!signal.aborted) event('sdk.error', { stage: 'process', code: error.name });
      },
    });
    return {
      spawnClaudeCodeProcess: harness.spawnClaudeCodeProcess,
      async cleanup() {
        const cleanup = await harness.cleanup();
        event('process.cleanup', { ...cleanup });
        if (harness.child && (!cleanup.rootExited || cleanup.remainingPids.length))
          return {
            cleanupUncertain: true,
            failure: '运行所属进程尚未确认全部退出，请核对执行轨迹。',
          };
        return { cleanupUncertain: false };
      },
    };
  }

  let child: ChildProcessWithoutNullStreams | undefined;
  let childExit: Promise<void> | undefined;
  let processExited = false;
  let cancelChildTimer: ReturnType<typeof setTimeout> | undefined;
  let stderrBytes = 0;
  const boundSdkCancellation = () => {
    cancelChildTimer = setTimeout(() => {
      if (!processExited) child?.kill('SIGKILL');
    }, cancelTimeoutMs);
    cancelChildTimer.unref();
  };
  const clearCancellation = () => {
    clearTimeout(cancelChildTimer);
    signal.removeEventListener('abort', boundSdkCancellation);
  };
  return {
    spawnClaudeCodeProcess(options) {
      const subprocess = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = subprocess;
      if (signal.aborted) boundSdkCancellation();
      else signal.addEventListener('abort', boundSdkCancellation, { once: true });
      event('process.spawned', { pid: subprocess.pid ?? null });
      subprocess.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
      });
      childExit = new Promise((resolve) => {
        subprocess.once('exit', (code, exitSignal) => {
          processExited = true;
          clearCancellation();
          event('process.exited', { code, signal: exitSignal, stderrBytes });
          resolve();
        });
        subprocess.once('error', (error: NodeJS.ErrnoException) => {
          if (!options.signal.aborted)
            event('sdk.error', { stage: 'process', code: error.code ?? null });
          if (!subprocess.pid) {
            processExited = true;
            resolve();
          }
        });
      });
      return subprocess;
    },
    async cleanup() {
      let failure: string | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        if (childExit && !processExited) {
          await Promise.race([
            childExit,
            new Promise<void>((resolve) => {
              deadline = setTimeout(() => {
                failure = 'SDK 未及时退出，已强制结束所属进程。';
                child?.kill('SIGKILL');
                resolve();
              }, cleanupTimeoutMs);
            }),
          ]);
          clearTimeout(deadline);
          if (!processExited) await childExit;
        }
        return failure === undefined
          ? { cleanupUncertain: false }
          : { cleanupUncertain: false, failure };
      } finally {
        clearCancellation();
      }
    },
  };
}
