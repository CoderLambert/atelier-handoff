/**
 * @file 提供终端生命周期故障测试的 PTY 边界替身。
 * @implementation 记录真实 manager 投递的字节，允许测试模拟迟到输出和迟到退出。
 * @updated 2026-11-26T01:00:00+08:00
 */
import type {
  TerminalProcess,
  TerminalProcessProvider,
  TerminalSpawnOptions,
} from '../../server/modules/terminal/process.js';
import type { TerminalServerFrame } from '../../shared/terminal.js';
import { setTimeout as delay } from 'node:timers/promises';

export class ProcessDouble implements TerminalProcess {
  readonly pid = 1234;
  readonly writes: Array<string | Buffer> = [];
  readonly sizes: Array<[number, number]> = [];
  readonly signals: NodeJS.Signals[] = [];
  paused = false;
  disposed = false;
  ignoreSignals = false;
  failResume = false;
  constructor(readonly options: TerminalSpawnOptions) {}
  write(data: string | Buffer) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  pause() {
    this.paused = true;
  }
  resume() {
    if (this.failResume) throw new Error('Disconnected read stream');
    this.paused = false;
  }
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    if (!this.ignoreSignals) queueMicrotask(() => this.exit());
  }
  dispose() {
    this.disposed = true;
  }
  output(data: string) {
    this.options.onData(data);
  }
  exit(code = 0) {
    this.options.onExit({ exitCode: code, signal: null });
  }
}
export function processDoubleProvider() {
  const processes: ProcessDouble[] = [];
  const provider: TerminalProcessProvider = {
    shellName: 'fixture-sh',
    prepare: async () => (options) => {
      const process = new ProcessDouble(options);
      processes.push(process);
      return process;
    },
  };
  return { processes, provider };
}
export class TerminalSink {
  bufferedAmount = 0;
  readonly frames: TerminalServerFrame[] = [];
  closed: string | undefined;
  send(frame: TerminalServerFrame) {
    this.frames.push(frame);
  }
  close(code: string) {
    this.closed = code;
  }
  async frame<T extends TerminalServerFrame['type']>(
    type: T,
  ): Promise<Extract<TerminalServerFrame, { type: T }>> {
    await until(() => this.frames.some((frame) => frame.type === type));
    const frame = this.frames.find(
      (frame): frame is Extract<TerminalServerFrame, { type: T }> => frame.type === type,
    );
    if (!frame) throw new Error('Missing terminal frame: ' + type);
    return frame;
  }
}
export async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal behavior');
    await delay(5);
  }
}
