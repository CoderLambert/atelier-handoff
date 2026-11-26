/**
 * @file 管理人工终端的会话归属和生命周期。
 * @implementation 在首次连接就绪后启动 PTY，以独立目录保留、串行屏幕和有界连接恢复处理重试与清理。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  terminalClientFrameSchema,
  terminalCreateRequestSchema,
  terminalHasActiveProcess,
  terminalLimits,
  terminalProtocol,
  terminalStreamPath,
  type TerminalCapabilities,
  type TerminalCloseResponse,
  type TerminalCreateRequest,
  type TerminalListResponse,
  type TerminalRecord,
  type TerminalServerFrame,
  type TerminalTicketResponse,
} from '../../../shared/terminal.js';
import { AppError, now } from '../../../shared/types.js';
import type { Store } from '../../store.js';
import type {
  DevelopmentWorktrees,
  TerminalWorkspaceReservation,
} from '../git/development-worktrees.js';
import {
  createTerminalProcessProvider,
  type TerminalProcess,
  type TerminalProcessExit,
  type TerminalProcessProvider,
  type TerminalSpawner,
} from './process.js';
import { TerminalScreen } from './screen.js';

export interface TerminalConnection {
  readonly bufferedAmount: number;
  send(frame: TerminalServerFrame): void;
  close(code: string): void;
}
export interface TerminalAttachment {
  readonly attachmentId: string;
  receive(frame: unknown): Promise<void>;
  detach(): void;
}
interface Attachment {
  id: string;
  connection: TerminalConnection;
  closed: boolean;
  ready: boolean;
  snapshotSeq?: number;
  lastSent: number;
  lastAck: number;
  inputSeq: number;
  commandSeq: number;
  finishSnapshot?: () => void;
  outstanding: Map<number, number>;
  outstandingBytes: number;
  releaseOutputWait?: () => void;
  outputWaitTimer?: ReturnType<typeof setTimeout>;
  timer?: ReturnType<typeof setTimeout>;
  readyWork?: Promise<void>;
}
interface Entry {
  record: TerminalRecord;
  fingerprint?: string;
  creation?: Promise<{ terminal: TerminalRecord }>;
  starting?: Promise<void>;
  closeWork?: Promise<TerminalCloseResponse>;
  reservation?: TerminalWorkspaceReservation;
  screen?: TerminalScreen;
  spawn?: TerminalSpawner;
  process?: TerminalProcess;
  observedExit: boolean;
  exitDone: Promise<void>;
  finishExit(): void;
  tail: Promise<void>;
  seq: number;
  queuedBytes: number;
  pauses: Set<string>;
  attachment?: Attachment;
  firstReadyTimer?: ReturnType<typeof setTimeout>;
}
interface Ticket {
  sessionId: string;
  terminalId: string;
  origin: string;
  expiresAt: number;
}
export interface TerminalManagerOptions {
  store: Store;
  worktrees: DevelopmentWorktrees;
  supported: boolean;
  unavailableReason?: TerminalCapabilities['reason'];
  isSessionDeleting(id: string): boolean;
  processProvider?: TerminalProcessProvider;
}
const terminalError = (code: string, status = 409) =>
  new AppError(code, '终端操作无法完成，请检查当前状态。', status);
const copy = (entry: Entry): TerminalRecord => ({ ...entry.record });
const closedStates = new Set(['closed', 'closing', 'cleanup-failed', 'failed']);
const frameBytes = (frame: TerminalServerFrame) => Buffer.byteLength(JSON.stringify(frame));
const outputPauseBytes = terminalLimits.outputWindowBytes - terminalLimits.frameBytes;
const outputResumeBytes = outputPauseBytes / 2;

/** Keep both UTF-8 data and its escaped JSON representation within frame budgets. */
function outputChunks(data: string): string[] {
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

export class TerminalManager {
  private readonly runtimeId = randomUUID();
  private readonly entries = new Map<string, Entry>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly provider?: TerminalProcessProvider;
  private readonly unavailableReason: TerminalCapabilities['reason'];
  private stopping = false;
  private shutdownWork?: Promise<{ closed: number; failed: string[] }>;

  constructor(private readonly options: TerminalManagerOptions) {
    this.unavailableReason = options.supported
      ? 'available'
      : (options.unavailableReason ?? 'runtime-unavailable');
    if (options.supported) {
      try {
        this.provider = options.processProvider ?? createTerminalProcessProvider();
      } catch {
        this.unavailableReason = 'runtime-unavailable';
      }
    }
  }
  capabilities(): TerminalCapabilities {
    return {
      supported: !!this.provider && !this.stopping,
      reason: this.stopping ? 'runtime-unavailable' : this.unavailableReason,
      runtimeId: this.runtimeId,
      shellName: this.provider?.shellName ?? null,
      protocolVersion: 1,
      limits: { perRuntime: terminalLimits.perRuntime, perSession: terminalLimits.perSession },
    };
  }
  private assertRuntime(runtimeId: string): void {
    if (runtimeId !== this.runtimeId) throw terminalError('TERMINAL_RUNTIME_CHANGED');
  }
  private assertSupported(): void {
    if (this.stopping) throw terminalError('SHUTTING_DOWN', 503);
    if (!this.provider) throw terminalError('TERMINAL_UNAVAILABLE', 403);
  }
  private session(sessionId: string, creating = false) {
    const session = this.options.store.get('sessions', sessionId);
    if (creating) {
      this.assertSupported();
      if (this.options.isSessionDeleting(sessionId)) throw terminalError('SESSION_DELETING');
      if (session.creatingFork) throw terminalError('FORK_NOT_READY');
      if (session.status !== 'active') throw terminalError('SESSION_ARCHIVED');
    }
    return session;
  }
  private owned(sessionId: string, terminalId: string): Entry {
    this.session(sessionId);
    const entry = this.entries.get(terminalId);
    if (!entry || entry.record.sessionId !== sessionId)
      throw terminalError('TERMINAL_NOT_FOUND', 404);
    return entry;
  }
  list(sessionId: string): TerminalListResponse {
    this.session(sessionId);
    return {
      runtimeId: this.runtimeId,
      terminals: [...this.entries.values()]
        .filter(
          (entry) =>
            entry.record.sessionId === sessionId &&
            !['closed', 'failed'].includes(entry.record.state),
        )
        .map(copy),
    };
  }
  private entry(sessionId: string, terminalId: string, cols = 80, rows = 24): Entry {
    const session = this.session(sessionId);
    let finishExit = () => {};
    const exitDone = new Promise<void>((resolve) => {
      finishExit = resolve;
    });
    return {
      record: {
        runtimeId: this.runtimeId,
        terminalId,
        sessionId,
        projectId: session.projectId,
        workspaceId: null,
        initialCwd: '',
        shellName: this.provider?.shellName ?? '',
        cols,
        rows,
        state: 'creating',
        createdAt: now(),
        exitCode: null,
        exitSignal: null,
      },
      observedExit: false,
      exitDone,
      finishExit,
      tail: Promise.resolve(),
      seq: 0,
      queuedBytes: 0,
      pauses: new Set(),
    };
  }
  async create(
    sessionId: string,
    raw: TerminalCreateRequest,
  ): Promise<{ terminal: TerminalRecord }> {
    const input = terminalCreateRequestSchema.parse(raw);
    this.assertRuntime(input.runtimeId);
    this.session(sessionId, true);
    const fingerprint = JSON.stringify(input);
    const prior = this.entries.get(input.terminalId);
    if (prior) {
      if (
        prior.record.sessionId !== sessionId ||
        (prior.fingerprint && prior.fingerprint !== fingerprint)
      )
        throw terminalError('TERMINAL_ID_CONFLICT');
      if (closedStates.has(prior.record.state)) throw terminalError('TERMINAL_CLOSED');
      if (prior.creation) await prior.creation;
      if (closedStates.has(prior.record.state)) throw terminalError('TERMINAL_CLOSED');
      return { terminal: copy(prior) };
    }
    const retained = [...this.entries.values()].filter(
      (entry) => !['closed', 'failed'].includes(entry.record.state),
    );
    if (
      this.entries.size >= terminalLimits.ledger ||
      retained.length >= terminalLimits.perRuntime ||
      retained.filter((entry) => entry.record.sessionId === sessionId).length >=
        terminalLimits.perSession
    )
      throw terminalError('TERMINAL_LIMIT');
    const entry = this.entry(sessionId, input.terminalId, input.cols, input.rows);
    entry.fingerprint = fingerprint;
    this.entries.set(input.terminalId, entry);
    entry.firstReadyTimer = setTimeout(() => {
      void this.closeEntry(entry);
    }, terminalLimits.firstReadyMs);
    entry.firstReadyTimer.unref();
    entry.creation = (async () => {
      try {
        entry.reservation = this.options.worktrees.reserveTerminalWorkspace(
          this.session(sessionId, true),
          input.expectedWorkspaceId,
        );
        const provider = this.provider;
        if (!provider) throw terminalError('TERMINAL_UNAVAILABLE', 403);
        const [cwd, spawn] = await Promise.all([entry.reservation.resolve(), provider.prepare()]);
        this.session(sessionId, true);
        if (closedStates.has(entry.record.state)) throw terminalError('TERMINAL_CLOSED');
        entry.reservation.assertSpawnAllowed();
        entry.spawn = spawn;
        entry.screen = new TerminalScreen(input.cols, input.rows);
        Object.assign(entry.record, {
          initialCwd: cwd,
          workspaceId: entry.reservation.workspaceId,
          state: 'awaiting-attach',
        });
        return { terminal: copy(entry) };
      } catch (error) {
        if (!closedStates.has(entry.record.state)) {
          entry.record.state = 'failed';
          entry.record.errorCode = error instanceof AppError ? error.code : 'TERMINAL_START_FAILED';
          clearTimeout(entry.firstReadyTimer);
          entry.reservation?.release();
          entry.reservation = undefined;
          entry.screen?.dispose();
          entry.screen = undefined;
        }
        throw error;
      }
    })();
    return entry.creation;
  }
  assertSessionIdle(sessionId: string): void {
    if (
      [...this.entries.values()].some(
        (entry) =>
          entry.record.sessionId === sessionId && terminalHasActiveProcess(entry.record.state),
      )
    )
      throw terminalError('TERMINAL_ACTIVE');
  }
  async disposeSession(sessionId: string): Promise<void> {
    this.assertSessionIdle(sessionId);
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.record.sessionId === sessionId)
        .map((entry) => this.closeEntry(entry)),
    );
  }
  ticket(
    sessionId: string,
    runtimeId: string,
    terminalId: string,
    origin: string,
  ): TerminalTicketResponse {
    this.assertRuntime(runtimeId);
    this.assertSupported();
    try {
      if (!origin || new URL(origin).origin !== origin) throw new Error();
    } catch {
      throw terminalError('ORIGIN_DENIED', 403);
    }
    const entry = this.owned(sessionId, terminalId);
    if (closedStates.has(entry.record.state) || entry.record.state === 'creating')
      throw terminalError('TERMINAL_CLOSED');
    if (entry.record.state !== 'exited') this.session(sessionId, true);
    this.revokeTickets(terminalId);
    const ticket = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + terminalLimits.ticketTtlMs;
    this.tickets.set(ticket, { sessionId, terminalId, origin, expiresAt });
    return {
      runtimeId,
      ticket,
      expiresAt: new Date(expiresAt).toISOString(),
      streamPath: terminalStreamPath,
      protocol: terminalProtocol,
    };
  }
  consumeTicket(ticket: string, origin: string): { sessionId: string; terminalId: string } {
    this.assertSupported();
    const claim = this.tickets.get(ticket);
    if (!claim || claim.origin !== origin || claim.expiresAt <= Date.now())
      throw terminalError('TERMINAL_TICKET_INVALID', 403);
    this.tickets.delete(ticket);
    const entry = this.owned(claim.sessionId, claim.terminalId);
    if (closedStates.has(entry.record.state)) throw terminalError('TERMINAL_CLOSED');
    if (entry.record.state !== 'exited') this.session(claim.sessionId, true);
    return { sessionId: claim.sessionId, terminalId: claim.terminalId };
  }
  private revokeTickets(terminalId: string): void {
    for (const [token, claim] of this.tickets)
      if (claim.terminalId === terminalId || claim.expiresAt <= Date.now())
        this.tickets.delete(token);
  }
  attach(
    sessionId: string,
    terminalId: string,
    connection: TerminalConnection,
  ): TerminalAttachment {
    this.assertSupported();
    const entry = this.owned(sessionId, terminalId);
    if (!entry.screen || closedStates.has(entry.record.state))
      throw terminalError('TERMINAL_CLOSED');
    if (entry.record.state !== 'exited') this.session(sessionId, true);
    if (entry.attachment) this.detach(entry, entry.attachment, 'TERMINAL_REPLACED');
    const attachment: Attachment = {
      id: randomUUID(),
      connection,
      closed: false,
      ready: false,
      lastSent: entry.seq,
      lastAck: entry.seq,
      inputSeq: 0,
      commandSeq: 0,
      outstanding: new Map(),
      outstandingBytes: 0,
    };
    entry.attachment = attachment;
    this.pause(entry, attachment.id, true);
    attachment.timer = setTimeout(
      () => this.detach(entry, attachment, 'TERMINAL_READY_TIMEOUT'),
      terminalLimits.snapshotTimeoutMs,
    );
    attachment.timer.unref();
    void this.order(entry, async () => {
      this.current(entry, attachment);
      const screen = entry.screen;
      if (!screen) throw terminalError('TERMINAL_CLOSED');
      const frame: TerminalServerFrame = {
        type: 'snapshot',
        attachmentId: attachment.id,
        seq: entry.seq,
        screen: screen.serialize(),
        terminal: copy(entry),
      };
      if (frameBytes(frame) > terminalLimits.snapshotBytes)
        throw terminalError('TERMINAL_SNAPSHOT_TOO_LARGE');
      attachment.snapshotSeq = entry.seq;
      attachment.lastSent = entry.seq;
      attachment.lastAck = entry.seq;
      if (connection.bufferedAmount + frameBytes(frame) > terminalLimits.snapshotBufferBytes)
        throw terminalError('TERMINAL_SLOW_CONSUMER');
      // Fence live writes behind snapshot consumption in the same ordered screen queue.
      const snapshotReady = new Promise<void>((resolve) => {
        attachment.finishSnapshot = resolve;
      });
      connection.send(frame);
      await snapshotReady;
    }).catch((error: unknown) =>
      this.detach(
        entry,
        attachment,
        error instanceof AppError ? error.code : 'TERMINAL_SNAPSHOT_FAILED',
      ),
    );
    return {
      attachmentId: attachment.id,
      receive: (frame) => this.receive(entry, attachment, frame),
      detach: () => this.detach(entry, attachment),
    };
  }
  private current(entry: Entry, attachment: Attachment): void {
    if (attachment.closed || entry.attachment !== attachment)
      throw terminalError('TERMINAL_REPLACED');
    if (closedStates.has(entry.record.state) || this.stopping)
      throw terminalError('TERMINAL_CLOSED');
  }
  private pause(entry: Entry, reason: string, paused: boolean): void {
    if (paused) entry.pauses.add(reason);
    else entry.pauses.delete(reason);
    if (!entry.process || entry.observedExit || closedStates.has(entry.record.state)) return;
    try {
      if (entry.pauses.size) entry.process.pause();
      else entry.process.resume();
    } catch {
      entry.record.errorCode = 'TERMINAL_PROCESS_FAILED';
      void this.closeEntry(entry);
    }
  }
  private detach(entry: Entry, attachment: Attachment, code?: string): void {
    if (attachment.closed) return;
    attachment.closed = true;
    clearTimeout(attachment.timer);
    attachment.finishSnapshot?.();
    attachment.finishSnapshot = undefined;
    attachment.releaseOutputWait?.();
    attachment.outstanding.clear();
    attachment.outstandingBytes = 0;
    if (entry.attachment === attachment) entry.attachment = undefined;
    this.pause(entry, attachment.id, false);
    if (code) {
      try {
        attachment.connection.send({ type: 'error', attachmentId: attachment.id, code });
      } catch {
        /* A closed peer cannot receive diagnostics. */
      }
      try {
        attachment.connection.close(code);
      } catch {
        /* Cleanup continues after a lost transport. */
      }
    }
  }
  private order<T>(entry: Entry, work: () => T | Promise<T>): Promise<T> {
    const next = entry.tail.then(work);
    entry.tail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  private send(entry: Entry, frame: TerminalServerFrame): void {
    const attachment = entry.attachment;
    if (!attachment?.ready || attachment.closed || frame.attachmentId !== attachment.id) return;
    const bytes = frameBytes(frame);
    if (
      attachment.connection.bufferedAmount + bytes > terminalLimits.liveBufferBytes ||
      ('seq' in frame && attachment.outstandingBytes + bytes > terminalLimits.outputWindowBytes)
    ) {
      this.detach(entry, attachment, 'TERMINAL_SLOW_CONSUMER');
      return;
    }
    try {
      attachment.connection.send(frame);
      if ('seq' in frame) {
        attachment.lastSent = frame.seq;
        attachment.outstanding.set(frame.seq, bytes);
        attachment.outstandingBytes += bytes;
      }
    } catch {
      this.detach(entry, attachment, 'TERMINAL_CONNECTION_LOST');
    }
  }
  private state(entry: Entry): void {
    entry.seq++;
    const attachment = entry.attachment;
    if (attachment)
      this.send(entry, {
        type: 'state',
        attachmentId: attachment.id,
        seq: entry.seq,
        terminal: copy(entry),
      });
  }
  private async waitForOutputCapacity(entry: Entry, attachment: Attachment): Promise<void> {
    // Only the ordered screen writer waits. The transport can still accept ACKs and input.
    await new Promise<void>((resolve) => {
      attachment.outputWaitTimer = setTimeout(
        () => this.detach(entry, attachment, 'TERMINAL_SLOW_CONSUMER'),
        terminalLimits.outputAckTimeoutMs,
      );
      attachment.outputWaitTimer.unref();
      attachment.releaseOutputWait = () => {
        clearTimeout(attachment.outputWaitTimer);
        attachment.outputWaitTimer = undefined;
        attachment.releaseOutputWait = undefined;
        resolve();
      };
      this.pause(entry, attachment.id, true);
    });
    if (!attachment.closed) this.pause(entry, attachment.id, false);
  }
  private output(entry: Entry, data: string): void {
    if (!entry.screen || ['closed', 'failed'].includes(entry.record.state)) return;
    const bytes = Buffer.byteLength(data);
    if (entry.queuedBytes + bytes > terminalLimits.screenHardBytes) {
      entry.record.errorCode = 'TERMINAL_OUTPUT_LIMIT';
      if (entry.attachment) this.detach(entry, entry.attachment, 'TERMINAL_OUTPUT_LIMIT');
      void this.closeEntry(entry);
      return;
    }
    entry.queuedBytes += bytes;
    if (entry.queuedBytes >= terminalLimits.screenHighBytes) this.pause(entry, 'screen', true);
    void this.order(entry, async () => {
      try {
        const screen = entry.screen;
        if (!screen) return;
        for (const chunk of outputChunks(data)) {
          const active = entry.attachment;
          if (active?.ready && active.outstandingBytes >= outputPauseBytes)
            await this.waitForOutputCapacity(entry, active);
          if (entry.screen !== screen) return;
          await screen.write(chunk);
          entry.seq++;
          const attachment = entry.attachment;
          if (attachment)
            this.send(entry, {
              type: 'output',
              attachmentId: attachment.id,
              seq: entry.seq,
              data: chunk,
            });
        }
      } finally {
        entry.queuedBytes -= bytes;
        if (entry.queuedBytes <= terminalLimits.screenLowBytes) this.pause(entry, 'screen', false);
      }
    }).catch(() => {
      entry.record.errorCode = 'TERMINAL_SCREEN_FAILED';
      void this.closeEntry(entry);
    });
  }
  private exited(entry: Entry, exit: TerminalProcessExit): void {
    if (entry.observedExit) return;
    entry.observedExit = true;
    entry.record.exitCode = exit.exitCode;
    entry.record.exitSignal = exit.signal;
    void this.order(entry, () => {
      entry.process?.dispose();
      entry.process = undefined;
      entry.reservation?.release();
      entry.reservation = undefined;
      entry.pauses.clear();
      if (['closing', 'cleanup-failed'].includes(entry.record.state)) this.finalizeClosed(entry);
      else {
        entry.record.state = 'exited';
        this.state(entry);
      }
      entry.finishExit();
    }).catch(() => {
      entry.record.state = 'cleanup-failed';
      entry.record.errorCode = 'TERMINAL_CLEANUP_FAILED';
      entry.finishExit();
    });
  }
  private async start(entry: Entry, attachment: Attachment): Promise<void> {
    if (entry.starting) await entry.starting.catch(() => {});
    this.current(entry, attachment);
    if (entry.process || entry.record.state === 'exited') return;
    entry.record.state = 'starting';
    const starting = (async () => {
      const reservation = entry.reservation;
      const spawn = entry.spawn;
      if (!reservation || !spawn) throw terminalError('TERMINAL_CLOSED');
      const cwd = await reservation.resolve();
      this.current(entry, attachment);
      this.session(entry.record.sessionId, true);
      reservation.assertSpawnAllowed();
      entry.process = spawn({
        cwd,
        cols: entry.record.cols,
        rows: entry.record.rows,
        onData: (data) => this.output(entry, data),
        onExit: (exit) => this.exited(entry, exit),
      });
      entry.record.state = 'running';
      this.pause(entry, attachment.id, true);
      clearTimeout(entry.firstReadyTimer);
    })();
    entry.starting = starting;
    try {
      await starting;
    } catch (error) {
      if (entry.record.state === 'starting') entry.record.state = 'awaiting-attach';
      throw error;
    } finally {
      if (entry.starting === starting) entry.starting = undefined;
    }
  }
  private async receive(entry: Entry, attachment: Attachment, raw: unknown): Promise<void> {
    this.current(entry, attachment);
    const frame = terminalClientFrameSchema.parse(raw);
    if (frame.attachmentId !== attachment.id) throw terminalError('TERMINAL_REPLACED');
    if (frame.type === 'ready') {
      if (frame.seq !== attachment.snapshotSeq) throw terminalError('TERMINAL_PROTOCOL_ERROR');
      if (attachment.readyWork) return attachment.readyWork;
      attachment.readyWork = (async () => {
        if (entry.record.state !== 'exited') await this.start(entry, attachment);
        this.current(entry, attachment);
        attachment.ready = true;
        clearTimeout(attachment.timer);
        this.send(entry, {
          type: 'readyAccepted',
          attachmentId: attachment.id,
          writable: entry.record.state === 'running' && !entry.observedExit,
          terminal: copy(entry),
        });
        attachment.finishSnapshot?.();
        attachment.finishSnapshot = undefined;
        this.pause(entry, attachment.id, false);
      })().catch((error: unknown) => {
        this.detach(
          entry,
          attachment,
          error instanceof AppError ? error.code : 'TERMINAL_START_FAILED',
        );
        throw error;
      });
      return attachment.readyWork;
    }
    if (!attachment.ready) throw terminalError('TERMINAL_NOT_READY');
    if (frame.type === 'outputAck') {
      if (frame.seq < attachment.lastAck || frame.seq > attachment.lastSent)
        throw terminalError('TERMINAL_PROTOCOL_ERROR');
      if (frame.seq === attachment.lastAck) return;
      attachment.lastAck = frame.seq;
      for (const [seq, bytes] of attachment.outstanding)
        if (seq <= frame.seq) {
          attachment.outstanding.delete(seq);
          attachment.outstandingBytes -= bytes;
        }
      if (attachment.outstandingBytes <= outputResumeBytes) attachment.releaseOutputWait?.();
      else attachment.outputWaitTimer?.refresh();
      return;
    }
    this.session(entry.record.sessionId, true);
    if (entry.record.state !== 'running' || !entry.process || entry.observedExit)
      throw terminalError('TERMINAL_NOT_RUNNING');
    if (frame.type === 'input') {
      if (frame.inputSeq !== attachment.inputSeq + 1)
        throw terminalError('TERMINAL_PROTOCOL_ERROR');
      attachment.inputSeq = frame.inputSeq;
      entry.process.write(
        frame.payload.encoding === 'utf8'
          ? frame.payload.data
          : Buffer.from(frame.payload.base64, 'base64'),
      );
      this.send(entry, {
        type: 'inputAccepted',
        attachmentId: attachment.id,
        inputSeq: frame.inputSeq,
      });
      return;
    }
    if (frame.commandSeq !== attachment.commandSeq + 1)
      throw terminalError('TERMINAL_PROTOCOL_ERROR');
    attachment.commandSeq = frame.commandSeq;
    await this.order(entry, () => {
      this.current(entry, attachment);
      this.session(entry.record.sessionId, true);
      if (!entry.process || entry.observedExit || entry.record.state !== 'running')
        throw terminalError('TERMINAL_NOT_RUNNING');
      entry.screen?.resize(frame.cols, frame.rows);
      entry.process.resize(frame.cols, frame.rows);
      entry.record.cols = frame.cols;
      entry.record.rows = frame.rows;
      entry.seq++;
      this.send(entry, {
        type: 'resized',
        attachmentId: attachment.id,
        seq: entry.seq,
        cols: frame.cols,
        rows: frame.rows,
      });
      this.send(entry, {
        type: 'commandResult',
        attachmentId: attachment.id,
        commandSeq: frame.commandSeq,
        ok: true,
      });
    });
  }
  async close(
    sessionId: string,
    runtimeId: string,
    terminalId: string,
  ): Promise<TerminalCloseResponse> {
    this.assertRuntime(runtimeId);
    this.session(sessionId);
    let entry = this.entries.get(terminalId);
    if (entry && entry.record.sessionId !== sessionId)
      throw terminalError('TERMINAL_NOT_FOUND', 404);
    if (!entry) {
      if (this.entries.size >= terminalLimits.ledger)
        return { runtimeId, terminalId, state: 'closed' };
      entry = this.entry(sessionId, terminalId);
      this.entries.set(terminalId, entry);
    }
    return this.closeEntry(entry);
  }
  private finalizeClosed(entry: Entry): void {
    clearTimeout(entry.firstReadyTimer);
    entry.reservation?.release();
    entry.reservation = undefined;
    entry.spawn = undefined;
    entry.screen?.dispose();
    entry.screen = undefined;
    entry.process?.dispose();
    entry.process = undefined;
    entry.pauses.clear();
    entry.record.state = 'closed';
  }
  private closeEntry(entry: Entry): Promise<TerminalCloseResponse> {
    const result = (): TerminalCloseResponse => ({
      runtimeId: this.runtimeId,
      terminalId: entry.record.terminalId,
      state:
        entry.record.state === 'closed'
          ? 'closed'
          : entry.record.state === 'cleanup-failed'
            ? 'cleanup-failed'
            : 'closing',
    });
    if (entry.record.state === 'closed') return Promise.resolve(result());
    if (entry.closeWork) return entry.closeWork;
    entry.record.state = 'closing';
    clearTimeout(entry.firstReadyTimer);
    this.revokeTickets(entry.record.terminalId);
    if (entry.attachment) this.detach(entry, entry.attachment, 'TERMINAL_CLOSED');
    entry.pauses.clear();
    try {
      entry.process?.resume();
    } catch {
      entry.record.errorCode = 'TERMINAL_CLEANUP_FAILED';
    }
    const work = (async () => {
      if (!entry.process) {
        this.finalizeClosed(entry);
        return result();
      }
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const signal = (name: NodeJS.Signals) => {
        if (!entry.observedExit) {
          try {
            entry.process?.kill(name);
          } catch {
            entry.record.errorCode = 'TERMINAL_CLEANUP_FAILED';
          }
        }
      };
      signal('SIGHUP');
      timers.push(setTimeout(() => signal('SIGTERM'), 2000));
      timers.push(setTimeout(() => signal('SIGKILL'), 3000));
      try {
        const completed = await Promise.race([
          entry.exitDone.then(() => true),
          new Promise<false>((resolve) => {
            timers.push(setTimeout(() => resolve(false), terminalLimits.closeTimeoutMs));
          }),
        ]);
        if (completed && entry.observedExit && entry.record.state !== 'closed')
          this.finalizeClosed(entry);
        if (!completed || entry.record.state !== 'closed') {
          entry.record.state = 'cleanup-failed';
          entry.record.errorCode = 'TERMINAL_CLEANUP_FAILED';
        }
        return result();
      } finally {
        for (const timer of timers) clearTimeout(timer);
      }
    })().catch(() => {
      entry.record.state = 'cleanup-failed';
      entry.record.errorCode = 'TERMINAL_CLEANUP_FAILED';
      return result();
    });
    entry.closeWork = work;
    void work.then(() => {
      if (entry.closeWork === work) entry.closeWork = undefined;
    });
    return work;
  }
  shutdown(): Promise<{ closed: number; failed: string[] }> {
    if (this.shutdownWork) return this.shutdownWork;
    this.stopping = true;
    this.tickets.clear();
    this.shutdownWork = (async () => {
      const entries = [...this.entries.values()];
      const results = await Promise.allSettled(
        entries.map((entry) => Promise.resolve().then(() => this.closeEntry(entry))),
      );
      const failed = results.flatMap((result, index) =>
        result.status === 'rejected' || result.value.state !== 'closed'
          ? [entries[index]?.record.terminalId ?? 'unknown']
          : [],
      );
      return { closed: entries.length - failed.length, failed };
    })();
    return this.shutdownWork;
  }
}
