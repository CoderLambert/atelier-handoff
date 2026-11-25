/**
 * @file 持有人工终端的解析器、连接与可移动视图。
 * @implementation 有界资源注册表按 runtime/terminal 唯一建实例；视图租约只挂载 DOM，协议按解析完成确认且不重放输入。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  splitTerminalInput,
  terminalLimits,
  terminalServerFrameSchema,
  type TerminalClientFrame,
  type TerminalRecord,
  type TerminalServerFrame,
} from '@shared/terminal';
import { requestTerminalAttachment } from '@/use-query/terminal/use-attach-terminal';

export type TerminalConnectionPhase =
  | 'idle'
  | 'connecting'
  | 'restoring'
  | 'connected'
  | 'disconnected'
  | 'replaced'
  | 'failed'
  | 'disposed';
export interface TerminalClientSnapshot {
  phase: TerminalConnectionPhase;
  record: TerminalRecord;
  inputUnconfirmed: boolean;
  restored: boolean;
  errorCode?: string;
}
interface TerminalClientCallbacks {
  receive(record: TerminalRecord): void;
  closed?(record: TerminalRecord): void;
  refreshRuntime(): unknown;
}
const encoder = new TextEncoder();
const clients = new Map<string, TerminalClientSession>();
let currentRuntime: string | undefined;
const clientKey = (record: Pick<TerminalRecord, 'runtimeId' | 'terminalId'>) =>
  `${record.runtimeId}:${record.terminalId}`;

export function activateTerminalRuntime(runtimeId: string): void {
  if (currentRuntime && currentRuntime !== runtimeId) disposeTerminalClients();
  currentRuntime = runtimeId;
}
export function disposeTerminalClients(): void {
  for (const client of clients.values()) client.dispose();
  clients.clear();
}
export function forgetTerminalClient(
  record: Pick<TerminalRecord, 'runtimeId' | 'terminalId'>,
): void {
  const key = clientKey(record);
  clients.get(key)?.dispose();
  clients.delete(key);
}
export function reconcileTerminalClients(
  runtimeId: string,
  sessionId: string,
  terminals: readonly TerminalRecord[],
): void {
  for (const client of clients.values()) {
    const record = client.getSnapshot().record;
    if (record.runtimeId !== runtimeId || record.sessionId !== sessionId) continue;
    const next = terminals.find((item) => item.terminalId === record.terminalId);
    if (!next || next.state === 'closed') forgetTerminalClient(record);
  }
}
export function getTerminalClient(
  record: TerminalRecord,
  callbacks: TerminalClientCallbacks,
): TerminalClientSession {
  if (currentRuntime && currentRuntime !== record.runtimeId)
    throw new Error('TERMINAL_RUNTIME_CHANGED');
  const key = clientKey(record);
  const existing = clients.get(key);
  if (existing) return existing;
  if (clients.size >= terminalLimits.perRuntime) {
    for (const client of clients.values()) {
      // A replaced/disconnected hidden parser cannot answer the PTY any longer.
      // Free only its local resources; live hidden connections are never evicted.
      if (!client.canRetireDisconnected()) continue;
      forgetTerminalClient(client.getSnapshot().record);
      break;
    }
  }
  if (clients.size >= terminalLimits.perRuntime) throw new Error('TERMINAL_LIMIT');
  const client = new TerminalClientSession(record, callbacks);
  // Register synchronously, before opening xterm, requesting a ticket, or connecting.
  clients.set(key, client);
  return client;
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', disposeTerminalClients);

export class TerminalClientSession {
  private snapshot: TerminalClientSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly container = document.createElement('div');
  private terminal?: Terminal;
  private fitAddon?: FitAddon;
  private socket?: WebSocket;
  private request?: AbortController;
  private view?: HTMLElement;
  private lease = 0;
  private epoch = 0;
  private attachmentId?: string;
  private sequence = 0;
  private inputSequence = 0;
  private commandSequence = 0;
  private readonly pendingInput = new Map<number, number>();
  private inputBytes = 0;
  private readonly pendingCommands = new Set<number>();
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private writable = false;
  private receivedSnapshot = false;
  private retryCount = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private fitFrame = 0;
  private lastResize?: { cols: number; rows: number };
  private focusPending = false;

  constructor(
    record: TerminalRecord,
    private readonly callbacks: TerminalClientCallbacks,
  ) {
    this.snapshot = { phase: 'idle', record, inputUnconfirmed: false, restored: false };
    this.container.className = 'terminal-client';
  }
  getSnapshot = (): TerminalClientSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  canRetireDisconnected(): boolean {
    return (
      !this.view?.isConnected &&
      ['disconnected', 'failed', 'replaced', 'disposed'].includes(this.snapshot.phase) &&
      (!this.socket || this.socket.readyState >= 2)
    );
  }
  private closed(): void {
    this.callbacks.closed?.(this.snapshot.record);
    forgetTerminalClient(this.snapshot.record);
  }
  private publish(update: Partial<TerminalClientSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  attachView(view: HTMLElement): { release(): void; fit(): void; focus(): void } {
    if (this.snapshot.phase === 'disposed') throw new Error('TERMINAL_CLOSED');
    const lease = ++this.lease;
    this.view = view;
    view.append(this.container);
    const measure = () => {
      if (lease !== this.lease || !view.isConnected) return;
      const bounds = view.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      if (!this.terminal) {
        const style = getComputedStyle(this.container);
        this.terminal = new Terminal({
          cols: this.snapshot.record.cols,
          rows: this.snapshot.record.rows,
          scrollback: terminalLimits.scrollback,
          fontSize: 13,
          cursorBlink: true,
          disableStdin: true,
          theme: {
            background: style.backgroundColor,
            foreground: style.color,
            cursor: style.color,
          },
        });
        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.open(this.container);
        this.terminal.onData((data) => this.sendInput(data));
        this.terminal.onBinary((data) => this.sendBinary(data));
        void this.connect();
      }
      this.scheduleFit();
    };
    measure();
    return {
      fit: measure,
      focus: () => {
        if (lease === this.lease) this.focus();
      },
      release: () => {
        if (lease !== this.lease) return;
        ++this.lease;
        this.terminal?.blur();
        this.focusPending = false;
        this.view = undefined;
        cancelAnimationFrame(this.fitFrame);
        this.container.remove();
        // Keep parser/WS active: disableStdin would also suppress DSR/DA responses.
      },
    };
  }
  focus(): void {
    const view = this.view;
    if (!view?.isConnected || view.getBoundingClientRect().width <= 0) return;
    if (this.snapshot.phase === 'connected') this.terminal?.focus();
    else {
      this.focusPending = true;
      view.focus({ preventScroll: true });
    }
  }
  reconnect(): void {
    if (!this.terminal || this.snapshot.phase === 'disposed') return;
    this.retryCount = 0;
    void this.connect();
  }
  private updateRecord(record: TerminalRecord): void {
    const own = this.snapshot.record;
    if (
      record.runtimeId !== own.runtimeId ||
      record.terminalId !== own.terminalId ||
      record.sessionId !== own.sessionId ||
      record.projectId !== own.projectId
    )
      throw new Error('TERMINAL_PROTOCOL');
    this.publish({ record });
    this.callbacks.receive(record);
  }
  private async connect(): Promise<void> {
    const epoch = ++this.epoch;
    clearTimeout(this.timer);
    clearTimeout(this.reconnectTimer);
    this.request?.abort();
    this.socket?.close();
    this.socket = undefined;
    this.writable = false;
    if (this.terminal) this.terminal.options.disableStdin = true;
    this.publish({
      phase: 'connecting',
      errorCode: undefined,
      inputUnconfirmed: this.snapshot.inputUnconfirmed || this.pendingInput.size > 0,
    });
    this.pendingInput.clear();
    this.inputBytes = 0;
    this.pendingCommands.clear();
    this.inputSequence = 0;
    this.commandSequence = 0;
    this.receivedSnapshot = false;
    this.attachmentId = undefined;
    this.lastResize = undefined;
    const request = new AbortController();
    this.request = request;
    this.timer = setTimeout(
      () => this.fail('TERMINAL_TIMEOUT', epoch),
      terminalLimits.snapshotTimeoutMs,
    );
    try {
      // Drain old xterm writes before resetting its parser for a new attachment.
      await this.tail;
      if (epoch !== this.epoch) return;
      const ticket = await requestTerminalAttachment(this.snapshot.record, request.signal);
      if (epoch !== this.epoch) return;
      const url = new URL(ticket.streamPath, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, [ticket.protocol, `ticket.${ticket.ticket}`]);
      this.socket = socket;
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (epoch !== this.epoch) return;
        if (typeof event.data !== 'string') return this.fail('TERMINAL_PROTOCOL', epoch);
        const bytes = encoder.encode(event.data).byteLength;
        this.queuedBytes += bytes;
        if (this.queuedBytes > terminalLimits.snapshotBufferBytes + terminalLimits.liveBufferBytes)
          return this.fail('TERMINAL_SLOW_CONSUMER', epoch);
        const raw = event.data;
        this.tail = this.tail
          .then(async () => {
            if (epoch !== this.epoch) return;
            const frame = terminalServerFrameSchema.parse(JSON.parse(raw));
            if (
              bytes >
              (frame.type === 'snapshot' ? terminalLimits.snapshotBytes : terminalLimits.frameBytes)
            )
              throw new Error('TERMINAL_PROTOCOL');
            await this.consume(frame, epoch);
          })
          .catch(() => this.fail('TERMINAL_PROTOCOL', epoch))
          .finally(() => {
            this.queuedBytes -= bytes;
          });
      };
      socket.onerror = () => {
        /* onclose owns recovery; no input is retried. */
      };
      socket.onclose = (event) => {
        if (epoch !== this.epoch || this.snapshot.phase === 'disposed') return;
        if (event.reason === 'TERMINAL_CLOSED') {
          this.closed();
          return;
        }
        const disconnectedEpoch = ++this.epoch;
        clearTimeout(this.timer);
        this.writable = false;
        if (this.terminal) this.terminal.options.disableStdin = true;
        const replaced = event.reason === 'TERMINAL_REPLACED' || this.snapshot.phase === 'replaced';
        const stopped =
          event.reason.startsWith('TERMINAL_') && event.reason !== 'TERMINAL_CONNECTION_LOST';
        this.publish({
          phase: replaced
            ? 'replaced'
            : stopped || this.snapshot.phase === 'failed'
              ? 'failed'
              : 'disconnected',
          errorCode: stopped ? event.reason : this.snapshot.errorCode,
          inputUnconfirmed: this.snapshot.inputUnconfirmed || this.pendingInput.size > 0,
        });
        if (
          !replaced &&
          this.snapshot.phase !== 'failed' &&
          this.retryCount < 3 &&
          this.snapshot.record.state !== 'closed'
        ) {
          const delay = 500 * 2 ** this.retryCount++;
          this.reconnectTimer = setTimeout(() => {
            if (disconnectedEpoch === this.epoch) void this.connect();
          }, delay);
        }
      };
    } catch (error) {
      if (epoch !== this.epoch) return;
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'TERMINAL_CONNECTION_FAILED';
      if (code === 'TERMINAL_CLOSED' || code === 'TERMINAL_NOT_FOUND') {
        this.closed();
        return;
      }
      this.fail(code, epoch);
      if (code === 'TERMINAL_RUNTIME_CHANGED') void this.callbacks.refreshRuntime();
    }
  }
  private async write(data: string): Promise<void> {
    const terminal = this.terminal;
    if (!terminal) throw new Error('TERMINAL_PROTOCOL');
    await new Promise<void>((resolve) => terminal.write(data, resolve));
  }
  private async consume(frame: TerminalServerFrame, epoch: number): Promise<void> {
    if (frame.type === 'error') {
      if (frame.code === 'TERMINAL_CLOSED') this.closed();
      else if (frame.code === 'TERMINAL_REPLACED') {
        this.publish({ phase: 'replaced', errorCode: frame.code });
        this.writable = false;
        if (this.terminal) this.terminal.options.disableStdin = true;
        this.socket?.close(1000, 'TERMINAL_REPLACED');
      } else this.fail(frame.code, epoch);
      return;
    }
    if (frame.type === 'snapshot') {
      if (this.receivedSnapshot || !this.terminal) throw new Error('TERMINAL_PROTOCOL');
      this.receivedSnapshot = true;
      this.attachmentId = frame.attachmentId;
      this.sequence = frame.seq;
      this.updateRecord(frame.terminal);
      this.publish({ phase: 'restoring', restored: frame.terminal.state !== 'awaiting-attach' });
      this.terminal.options.disableStdin = true;
      this.terminal.reset();
      this.terminal.resize(frame.terminal.cols, frame.terminal.rows);
      await this.write(frame.screen);
      if (epoch !== this.epoch) return;
      this.terminal.options.disableStdin = false;
      this.send({ type: 'ready', attachmentId: frame.attachmentId, seq: frame.seq });
      return;
    }
    if (!this.attachmentId || frame.attachmentId !== this.attachmentId)
      throw new Error('TERMINAL_PROTOCOL');
    if (frame.type === 'readyAccepted') {
      if (this.snapshot.phase !== 'restoring') throw new Error('TERMINAL_PROTOCOL');
      clearTimeout(this.timer);
      this.updateRecord(frame.terminal);
      this.retryCount = 0;
      this.writable = frame.writable;
      if (this.terminal) this.terminal.options.disableStdin = !this.writable;
      this.publish({ phase: 'connected', errorCode: undefined });
      this.scheduleFit();
      if (
        this.focusPending &&
        this.view &&
        (document.activeElement === this.view || this.view.contains(document.activeElement))
      )
        this.focus();
      this.focusPending = false;
      return;
    }
    if (frame.type === 'inputAccepted') {
      const bytes = this.pendingInput.get(frame.inputSeq);
      if (bytes === undefined) throw new Error('TERMINAL_PROTOCOL');
      this.pendingInput.delete(frame.inputSeq);
      this.inputBytes -= bytes;
      return;
    }
    if (frame.type === 'commandResult') {
      if (!this.pendingCommands.delete(frame.commandSeq)) throw new Error('TERMINAL_PROTOCOL');
      if (!frame.ok) this.lastResize = undefined;
      return;
    }
    if (this.snapshot.phase !== 'connected' || frame.seq !== this.sequence + 1)
      throw new Error('TERMINAL_PROTOCOL');
    if (frame.type === 'output') await this.write(frame.data);
    else if (frame.type === 'resized') this.terminal?.resize(frame.cols, frame.rows);
    else if (frame.type === 'state') {
      this.updateRecord(frame.terminal);
      if (!['running', 'starting'].includes(frame.terminal.state)) {
        this.writable = false;
        if (this.terminal) this.terminal.options.disableStdin = true;
      }
    }
    if (epoch !== this.epoch) return;
    this.sequence = frame.seq;
    this.send({ type: 'outputAck', attachmentId: this.attachmentId, seq: this.sequence });
    if (frame.type === 'state' && frame.terminal.state === 'closed')
      forgetTerminalClient(frame.terminal);
  }
  private send(frame: TerminalClientFrame): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const data = JSON.stringify(frame);
    if (
      encoder.encode(data).byteLength > terminalLimits.frameBytes ||
      socket.bufferedAmount > terminalLimits.liveBufferBytes
    ) {
      this.fail('TERMINAL_SLOW_CONSUMER', this.epoch);
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch {
      this.fail('TERMINAL_CONNECTION_LOST', this.epoch);
      return false;
    }
  }
  private sendInput(data: string): void {
    if (!data || !this.writable || this.snapshot.phase !== 'connected' || !this.attachmentId)
      return;
    for (const frame of splitTerminalInput(data, this.attachmentId, this.inputSequence + 1)) {
      const bytes = encoder.encode(frame.payload.data).byteLength;
      if (!this.reserveInput(frame.inputSeq, bytes) || !this.send(frame)) return;
      this.inputSequence = frame.inputSeq;
    }
  }
  private sendBinary(data: string): void {
    if (!this.writable || this.snapshot.phase !== 'connected' || !this.attachmentId) return;
    for (let offset = 0; offset < data.length; offset += terminalLimits.inputBytes) {
      const chunk = data.slice(offset, offset + terminalLimits.inputBytes);
      const inputSeq = this.inputSequence + 1;
      if (
        !this.reserveInput(inputSeq, chunk.length) ||
        !this.send({
          type: 'input',
          attachmentId: this.attachmentId,
          inputSeq,
          payload: { encoding: 'binary', base64: btoa(chunk) },
        })
      )
        return;
      this.inputSequence = inputSeq;
    }
  }
  private reserveInput(sequence: number, bytes: number): boolean {
    if (this.inputBytes + bytes > terminalLimits.liveBufferBytes) {
      this.fail('TERMINAL_SLOW_CONSUMER', this.epoch);
      return false;
    }
    this.pendingInput.set(sequence, bytes);
    this.inputBytes += bytes;
    return true;
  }
  private scheduleFit(): void {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      if (
        !this.view?.isConnected ||
        this.snapshot.phase !== 'connected' ||
        !this.attachmentId ||
        !this.writable
      )
        return;
      const bounds = this.view.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0 || document.hidden) return;
      const proposed = this.fitAddon?.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;
      const cols = Math.max(
        terminalLimits.minCols,
        Math.min(terminalLimits.maxCols, proposed.cols),
      );
      const rows = Math.max(
        terminalLimits.minRows,
        Math.min(terminalLimits.maxRows, proposed.rows),
      );
      if (this.lastResize?.cols === cols && this.lastResize.rows === rows) return;
      if (this.terminal?.cols === cols && this.terminal.rows === rows) return;
      const commandSeq = ++this.commandSequence;
      this.pendingCommands.add(commandSeq);
      if (this.send({ type: 'resize', attachmentId: this.attachmentId, commandSeq, cols, rows }))
        this.lastResize = { cols, rows };
    });
  }
  private fail(code: string, epoch: number): void {
    if (epoch !== this.epoch || this.snapshot.phase === 'disposed') return;
    ++this.epoch;
    clearTimeout(this.timer);
    clearTimeout(this.reconnectTimer);
    this.request?.abort();
    this.writable = false;
    if (this.terminal) this.terminal.options.disableStdin = true;
    this.publish({
      phase: 'failed',
      errorCode: code,
      inputUnconfirmed: this.snapshot.inputUnconfirmed || this.pendingInput.size > 0,
    });
    this.socket?.close(1000, code.slice(0, 80));
  }
  dispose(): void {
    if (this.snapshot.phase === 'disposed') return;
    ++this.epoch;
    clearTimeout(this.timer);
    clearTimeout(this.reconnectTimer);
    cancelAnimationFrame(this.fitFrame);
    this.request?.abort();
    this.socket?.close();
    this.terminal?.dispose();
    this.container.remove();
    this.view = undefined;
    this.pendingInput.clear();
    this.pendingCommands.clear();
    this.publish({ phase: 'disposed' });
    this.listeners.clear();
  }
}
