/**
 * @file 创建人工终端的本机 PTY 进程。
 * @implementation 选择可执行用户 shell、剔除运行时私有环境，并封装 node-pty 的读写和实际退出事件。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { accessSync, constants } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from '../../../shared/types.js';

export interface TerminalProcessExit {
  exitCode: number;
  signal: number | null;
}
export interface TerminalProcess {
  readonly pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal: NodeJS.Signals): void;
  dispose(): void;
}
export interface TerminalSpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  onData(data: string): void;
  onExit(exit: TerminalProcessExit): void;
}
export type TerminalSpawner = (options: TerminalSpawnOptions) => TerminalProcess;
export interface TerminalProcessProvider {
  readonly shellName: string;
  prepare(): Promise<TerminalSpawner>;
}

export function terminalEnvironment(
  source: NodeJS.ProcessEnv,
  runtimeBin?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  const blocked = new Set([
    'SHUNT_CHATGPT_PLAN_ACCOUNTS_DIR',
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_CHANNEL_FD',
    'NODE_CHANNEL_SERIALIZATION_MODE',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_ENABLE_LOGGING',
    'ELECTRON_NO_ATTACH_CONSOLE',
  ]);
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith('ATELIER_') && !blocked.has(key)) env[key] = value;
  }
  if (runtimeBin && env.PATH?.split(delimiter)[0] === runtimeBin)
    env.PATH = env.PATH.split(delimiter).slice(1).join(delimiter);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'atelier';
  env.LANG ??= 'C.UTF-8';
  return env;
}

export function createTerminalProcessProvider(
  options: { shell?: string; environment?: NodeJS.ProcessEnv } = {},
): TerminalProcessProvider {
  let loginShell: string | null = null;
  try {
    loginShell = userInfo().shell;
  } catch {
    /* Fall back to system shells. */
  }
  const shell = [options.shell ?? loginShell, '/bin/bash', '/bin/sh'].find((candidate) => {
    if (!candidate || !isAbsolute(candidate)) return false;
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!shell) throw new AppError('TERMINAL_UNAVAILABLE', '找不到可执行的本机 shell。', 403);
  const runtimeBin = join(fileURLToPath(new URL('../../../', import.meta.url)), 'bin');
  const env = terminalEnvironment(
    options.environment ?? process.env,
    dirname(process.execPath) === runtimeBin ? runtimeBin : undefined,
  );
  let prepared: Promise<TerminalSpawner> | undefined;
  return {
    shellName: basename(shell),
    prepare: () =>
      (prepared ??= import('node-pty').then(({ spawn }) => (input) => {
        const pty = spawn(shell, [], {
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          name: 'xterm-256color',
          env,
          encoding: 'utf8',
          handleFlowControl: false,
        });
        const output = pty.onData(input.onData);
        const exit = pty.onExit((value) =>
          input.onExit({
            exitCode: value.exitCode,
            signal: value.signal && value.signal > 0 ? value.signal : null,
          }),
        );
        return {
          pid: pty.pid,
          write: (data) => pty.write(data),
          resize: (cols, rows) => pty.resize(cols, rows),
          pause: () => {
            pty.pause();
          },
          resume: () => {
            pty.resume();
          },
          kill: (signal) => pty.kill(signal),
          dispose: () => {
            output.dispose();
            exit.dispose();
          },
        };
      })),
  };
}
