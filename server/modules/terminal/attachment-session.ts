/**
 * @file 封装终端单条 WebSocket 附件连接的快照围栏、高低水位流控与帧序校验。
 * @implementation 按单帧单次序列化计算 UTF-8 JSON 字节长度并透传预序列化负载，协调 512/384/192 KiB 流控窗口与对称关闭清理。
 * @updated 2026-11-27T22:10:00+08:00
 */
import { AppError } from '../../../shared/errors.js';
import {
  terminalLimits,
  type TerminalRecord,
  type TerminalServerFrame,
} from '../../../shared/terminal.js';
import type { TerminalScreen } from './screen.js';

export interface TerminalConnection {
  readonly bufferedAmount: number;
  send(frame: TerminalServerFrame, encoded?: string): void;
  close(code: string): void;
}

export interface TerminalAttachment {
  readonly attachmentId: string;
  receive(frame: unknown): Promise<void>;
  detach(): void;
}

export const OUTPUT_PAUSE_BYTES = terminalLimits.outputWindowBytes - terminalLimits.frameBytes;
export const OUTPUT_RESUME_BYTES = OUTPUT_PAUSE_BYTES / 2;

const protocolError = (code: string, status = 409) =>
  new AppError(code, '终端操作无法完成，请检查当前状态。', status);

function serializeFrame(frame: TerminalServerFrame): { encoded: string; bytes: number } {
  const encoded = JSON.stringify(frame);
  return { encoded, bytes: Buffer.byteLength(encoded) };
}

export interface TerminalAttachmentHost {
  onSetPause(reason: string, paused: boolean): void;
  onClosed(session: TerminalAttachmentSession): void;
}

export class TerminalAttachmentSession {
  closed = false;
  ready = false;
  snapshotSeq?: number;
  lastSent: number;
  lastAck: number;
  inputSeq = 0;
  commandSeq = 0;
  readyWork?: Promise<void>;

  private readonly outstanding = new Map<number, number>();
  private outstandingBytes = 0;
  private finishSnapshot?: () => void;
  private releaseOutputWait?: () => void;
  private outputWaitTimer?: ReturnType<typeof setTimeout>;
  private readyTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly id: string,
    private readonly connection: TerminalConnection,
    initialSeq: number,
    private readonly host: TerminalAttachmentHost,
  ) {
    this.lastSent = initialSeq;
    this.lastAck = initialSeq;
    this.readyTimer = setTimeout(
      () => this.close('TERMINAL_READY_TIMEOUT'),
      terminalLimits.snapshotTimeoutMs,
    );
    this.readyTimer.unref();
  }

  get pendingOutputBytes(): number {
    return this.outstandingBytes;
  }

  shouldPauseOutput(): boolean {
    return this.ready && this.outstandingBytes >= OUTPUT_PAUSE_BYTES;
  }

  async sendSnapshotAndWait(
    seq: number,
    screen: TerminalScreen,
    terminal: TerminalRecord,
  ): Promise<void> {
    const frame: TerminalServerFrame = {
      type: 'snapshot',
      attachmentId: this.id,
      seq,
      screen: screen.serialize(),
      terminal,
    };
    const { encoded, bytes } = serializeFrame(frame);
    if (bytes > terminalLimits.snapshotBytes) {
      throw protocolError('TERMINAL_SNAPSHOT_TOO_LARGE');
    }
    this.snapshotSeq = seq;
    this.lastSent = seq;
    this.lastAck = seq;
    if (this.connection.bufferedAmount + bytes > terminalLimits.snapshotBufferBytes) {
      throw protocolError('TERMINAL_SLOW_CONSUMER');
    }
    // Fence live writes behind snapshot consumption in the same ordered screen queue.
    const snapshotReady = new Promise<void>((resolve) => {
      this.finishSnapshot = resolve;
    });
    this.connection.send(frame, encoded);
    await snapshotReady;
  }

  completeReady(writable: boolean, terminal: TerminalRecord): void {
    this.ready = true;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.sendFrame({
      type: 'readyAccepted',
      attachmentId: this.id,
      writable,
      terminal,
    });
    this.finishSnapshot?.();
    this.finishSnapshot = undefined;
    this.host.onSetPause(this.id, false);
  }

  sendFrame(frame: TerminalServerFrame): void {
    if (!this.ready || this.closed || frame.attachmentId !== this.id) return;
    const { encoded, bytes } = serializeFrame(frame);
    if (
      this.connection.bufferedAmount + bytes > terminalLimits.liveBufferBytes ||
      ('seq' in frame && this.outstandingBytes + bytes > terminalLimits.outputWindowBytes)
    ) {
      this.close('TERMINAL_SLOW_CONSUMER');
      return;
    }
    try {
      this.connection.send(frame, encoded);
      if ('seq' in frame) {
        this.lastSent = frame.seq;
        this.outstanding.set(frame.seq, bytes);
        this.outstandingBytes += bytes;
      }
    } catch {
      this.close('TERMINAL_CONNECTION_LOST');
    }
  }

  async waitForOutputCapacity(): Promise<void> {
    // Only the ordered screen writer waits. The transport can still accept ACKs and input.
    await new Promise<void>((resolve) => {
      this.outputWaitTimer = setTimeout(
        () => this.close('TERMINAL_SLOW_CONSUMER'),
        terminalLimits.outputAckTimeoutMs,
      );
      this.outputWaitTimer.unref();
      this.releaseOutputWait = () => {
        clearTimeout(this.outputWaitTimer);
        this.outputWaitTimer = undefined;
        this.releaseOutputWait = undefined;
        resolve();
      };
      this.host.onSetPause(this.id, true);
    });
    if (!this.closed) this.host.onSetPause(this.id, false);
  }

  acknowledgeOutput(seq: number): void {
    if (seq < this.lastAck || seq > this.lastSent) {
      throw protocolError('TERMINAL_PROTOCOL_ERROR');
    }
    if (seq === this.lastAck) return;
    this.lastAck = seq;
    for (const [sentSeq, bytes] of this.outstanding) {
      if (sentSeq <= seq) {
        this.outstanding.delete(sentSeq);
        this.outstandingBytes -= bytes;
      }
    }
    if (this.outstandingBytes <= OUTPUT_RESUME_BYTES) this.releaseOutputWait?.();
    else this.outputWaitTimer?.refresh();
  }

  acceptInputSeq(seq: number): void {
    if (seq !== this.inputSeq + 1) throw protocolError('TERMINAL_PROTOCOL_ERROR');
    this.inputSeq = seq;
  }

  acceptCommandSeq(seq: number): void {
    if (seq !== this.commandSeq + 1) throw protocolError('TERMINAL_PROTOCOL_ERROR');
    this.commandSeq = seq;
  }

  close(code?: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.finishSnapshot?.();
    this.finishSnapshot = undefined;
    this.releaseOutputWait?.();
    this.outstanding.clear();
    this.outstandingBytes = 0;
    this.host.onClosed(this);
    if (code) {
      try {
        this.connection.send({ type: 'error', attachmentId: this.id, code });
      } catch {
        /* A closed peer cannot receive diagnostics. */
      }
      try {
        this.connection.close(code);
      } catch {
        /* Cleanup continues after a lost transport. */
      }
    }
  }
}
