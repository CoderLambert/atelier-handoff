/**
 * @file 定义单个终端实例的状态谓词、输出分片、屏幕顺序队列与资源清理原语。
 * @implementation 统一多处关闭与运行状态判断口径，维护 PTY 暂停集合与有序异步队列。
 * @updated 2026-11-27T22:10:00+08:00
 */
import { AppError } from '../../../shared/errors.js';
import {
  terminalLimits,
  type TerminalCloseResponse,
  type TerminalRecord,
} from '../../../shared/terminal.js';
import type { TerminalWorkspaceReservation } from '../git/development-worktrees.js';
import type { TerminalAttachmentSession } from './attachment-session.js';
import type { TerminalProcess, TerminalSpawner } from './process.js';
import type { TerminalScreen } from './screen.js';

export type TerminalState = TerminalRecord['state'];

export function isTerminalClosedOrClosing(state: TerminalState): boolean {
  return (
    state === 'closed' || state === 'closing' || state === 'cleanup-failed' || state === 'failed'
  );
}

export function isTerminalRetained(state: TerminalState): boolean {
  return state !== 'closed' && state !== 'failed';
}

export function isTerminalClosing(state: TerminalState): boolean {
  return state === 'closing' || state === 'cleanup-failed';
}

export function isTerminalRunning(record: TerminalRecord, observedExit: boolean): boolean {
  return record.state === 'running' && !observedExit;
}

/** Keep both UTF-8 data and its escaped JSON representation within frame budgets. */
export function outputChunks(data: string): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;
  let encoded = 0;
  for (const point of data) {
    const length = Buffer.byteLength(point);
    const escaped = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (
      bytes + length > terminalLimits.outputChunkBytes ||
      encoded + escaped > terminalLimits.frameBytes - 256
    ) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
      encoded = 0;
    }
    chunk += point;
    bytes += length;
    encoded += escaped;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export class TerminalInstance {
  fingerprint?: string;
  creation?: Promise<{ terminal: TerminalRecord }>;
  starting?: Promise<void>;
  closeWork?: Promise<TerminalCloseResponse>;
  reservation?: TerminalWorkspaceReservation;
  screen?: TerminalScreen;
  spawn?: TerminalSpawner;
  process?: TerminalProcess;
  observedExit = false;
  readonly exitDone: Promise<void>;
  finishExit: () => void = () => {};
  seq = 0;
  queuedBytes = 0;
  readonly pauses = new Set<string>();
  attachment?: TerminalAttachmentSession;
  firstReadyTimer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly record: TerminalRecord) {
    this.exitDone = new Promise<void>((resolve) => {
      this.finishExit = resolve;
    });
  }

  snapshotRecord(): TerminalRecord {
    return { ...this.record };
  }

  enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  setPause(reason: string, paused: boolean, onFailure: () => void): void {
    if (paused) this.pauses.add(reason);
    else this.pauses.delete(reason);
    if (!this.process || this.observedExit || isTerminalClosedOrClosing(this.record.state)) return;
    try {
      if (this.pauses.size) this.process.pause();
      else this.process.resume();
    } catch {
      this.record.errorCode = 'TERMINAL_PROCESS_FAILED';
      onFailure();
    }
  }

  failStart(error: unknown): void {
    if (isTerminalClosedOrClosing(this.record.state)) return;
    this.record.state = 'failed';
    this.record.errorCode = error instanceof AppError ? error.code : 'TERMINAL_START_FAILED';
    clearTimeout(this.firstReadyTimer);
    this.reservation?.release();
    this.reservation = undefined;
    this.screen?.dispose();
    this.screen = undefined;
  }

  finalizeClosed(): void {
    clearTimeout(this.firstReadyTimer);
    this.reservation?.release();
    this.reservation = undefined;
    this.spawn = undefined;
    this.screen?.dispose();
    this.screen = undefined;
    this.process?.dispose();
    this.process = undefined;
    this.pauses.clear();
    this.record.state = 'closed';
  }
}
