/**
 * @file 管理人工终端的会话归属和生命周期。
 * @implementation 协调终端进程、票据、工作树占用及清理，报告活动进程供重启判断。
 * @updated 2026-12-08T12:00:00+00:00
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
  type TerminalTicketResponse,
} from '../../../shared/terminal.js';
import { AppError, now } from '../../../shared/errors.js';
import type { Store } from '../../store.js';
import type { DevelopmentWorktrees } from '../git/development-worktrees.js';
import {
  createTerminalProcessProvider,
  type TerminalProcessExit,
  type TerminalProcessProvider,
} from './process.js';
import { TerminalScreen } from './screen.js';
import {
  TerminalAttachmentSession,
  type TerminalAttachment,
  type TerminalConnection,
} from './attachment-session.js';
import {
  isTerminalClosedOrClosing,
  isTerminalClosing,
  isTerminalRetained,
  isTerminalRunning,
  outputChunks,
  TerminalInstance,
} from './terminal-instance.js';

export type { TerminalAttachment, TerminalConnection };

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

export class TerminalManager {
  private readonly runtimeId = randomUUID();
  private readonly entries = new Map<string, TerminalInstance>();
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

  private owned(sessionId: string, terminalId: string): TerminalInstance {
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
          (entry) => entry.record.sessionId === sessionId && isTerminalRetained(entry.record.state),
        )
        .map((entry) => entry.snapshotRecord()),
    };
  }

  private createEntry(
    sessionId: string,
    terminalId: string,
    cols = 80,
    rows = 24,
  ): TerminalInstance {
    const session = this.session(sessionId);
    return new TerminalInstance({
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
    });
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
      if (isTerminalClosedOrClosing(prior.record.state)) throw terminalError('TERMINAL_CLOSED');
      if (prior.creation) await prior.creation;
      if (isTerminalClosedOrClosing(prior.record.state)) throw terminalError('TERMINAL_CLOSED');
      return { terminal: prior.snapshotRecord() };
    }
    const retained = [...this.entries.values()].filter((entry) =>
      isTerminalRetained(entry.record.state),
    );
    if (
      this.entries.size >= terminalLimits.ledger ||
      retained.length >= terminalLimits.perRuntime ||
      retained.filter((entry) => entry.record.sessionId === sessionId).length >=
        terminalLimits.perSession
    )
      throw terminalError('TERMINAL_LIMIT');
    const entry = this.createEntry(sessionId, input.terminalId, input.cols, input.rows);
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
        if (isTerminalClosedOrClosing(entry.record.state)) throw terminalError('TERMINAL_CLOSED');
        entry.reservation.assertSpawnAllowed();
        entry.spawn = spawn;
        entry.screen = new TerminalScreen(input.cols, input.rows);
        Object.assign(entry.record, {
          initialCwd: cwd,
          workspaceId: entry.reservation.workspaceId,
          state: 'awaiting-attach',
        });
        return { terminal: entry.snapshotRecord() };
      } catch (error) {
        entry.failStart(error);
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
    if (isTerminalClosedOrClosing(entry.record.state) || entry.record.state === 'creating')
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
    if (isTerminalClosedOrClosing(entry.record.state)) throw terminalError('TERMINAL_CLOSED');
    if (entry.record.state !== 'exited') this.session(claim.sessionId, true);
    return { sessionId: claim.sessionId, terminalId: claim.terminalId };
  }

  private revokeTickets(terminalId: string): void {
    for (const [token, claim] of this.tickets) {
      if (claim.terminalId === terminalId || claim.expiresAt <= Date.now()) {
        this.tickets.delete(token);
      }
    }
  }

  attach(
    sessionId: string,
    terminalId: string,
    connection: TerminalConnection,
  ): TerminalAttachment {
    this.assertSupported();
    const entry = this.owned(sessionId, terminalId);
    if (!entry.screen || isTerminalClosedOrClosing(entry.record.state)) {
      throw terminalError('TERMINAL_CLOSED');
    }
    if (entry.record.state !== 'exited') this.session(sessionId, true);
    entry.attachment?.close('TERMINAL_REPLACED');

    const attachment = new TerminalAttachmentSession(randomUUID(), connection, entry.seq, {
      onSetPause: (reason, paused) => this.pause(entry, reason, paused),
      onClosed: (closedAttachment) => {
        if (entry.attachment === closedAttachment) entry.attachment = undefined;
        this.pause(entry, closedAttachment.id, false);
      },
    });
    entry.attachment = attachment;
    this.pause(entry, attachment.id, true);

    void entry
      .enqueue(async () => {
        this.current(entry, attachment);
        const screen = entry.screen;
        if (!screen) throw terminalError('TERMINAL_CLOSED');
        await attachment.sendSnapshotAndWait(entry.seq, screen, entry.snapshotRecord());
      })
      .catch((error: unknown) =>
        attachment.close(error instanceof AppError ? error.code : 'TERMINAL_SNAPSHOT_FAILED'),
      );

    return {
      attachmentId: attachment.id,
      receive: (frame) => this.receive(entry, attachment, frame),
      detach: () => attachment.close(),
    };
  }

  private current(entry: TerminalInstance, attachment: TerminalAttachmentSession): void {
    if (attachment.closed || entry.attachment !== attachment)
      throw terminalError('TERMINAL_REPLACED');
    if (isTerminalClosedOrClosing(entry.record.state) || this.stopping)
      throw terminalError('TERMINAL_CLOSED');
  }

  private pause(entry: TerminalInstance, reason: string, paused: boolean): void {
    entry.setPause(reason, paused, () => {
      void this.closeEntry(entry);
    });
  }

  private emitState(entry: TerminalInstance): void {
    entry.seq++;
    const attachment = entry.attachment;
    if (attachment) {
      attachment.sendFrame({
        type: 'state',
        attachmentId: attachment.id,
        seq: entry.seq,
        terminal: entry.snapshotRecord(),
      });
    }
  }

  private output(entry: TerminalInstance, data: string): void {
    if (!entry.screen || !isTerminalRetained(entry.record.state)) return;
    const bytes = Buffer.byteLength(data);
    if (entry.queuedBytes + bytes > terminalLimits.screenHardBytes) {
      entry.record.errorCode = 'TERMINAL_OUTPUT_LIMIT';
      entry.attachment?.close('TERMINAL_OUTPUT_LIMIT');
      void this.closeEntry(entry);
      return;
    }
    entry.queuedBytes += bytes;
    if (entry.queuedBytes >= terminalLimits.screenHighBytes) this.pause(entry, 'screen', true);
    void entry
      .enqueue(async () => {
        try {
          const screen = entry.screen;
          if (!screen) return;
          for (const chunk of outputChunks(data)) {
            const active = entry.attachment;
            if (active?.shouldPauseOutput()) await active.waitForOutputCapacity();
            if (entry.screen !== screen) return;
            await screen.write(chunk);
            entry.seq++;
            entry.attachment?.sendFrame({
              type: 'output',
              attachmentId: entry.attachment.id,
              seq: entry.seq,
              data: chunk,
            });
          }
        } finally {
          entry.queuedBytes -= bytes;
          if (entry.queuedBytes <= terminalLimits.screenLowBytes)
            this.pause(entry, 'screen', false);
        }
      })
      .catch(() => {
        entry.record.errorCode = 'TERMINAL_SCREEN_FAILED';
        void this.closeEntry(entry);
      });
  }

  private exited(entry: TerminalInstance, exit: TerminalProcessExit): void {
    if (entry.observedExit) return;
    entry.observedExit = true;
    entry.record.exitCode = exit.exitCode;
    entry.record.exitSignal = exit.signal;
    void entry
      .enqueue(() => {
        entry.process?.dispose();
        entry.process = undefined;
        entry.reservation?.release();
        entry.reservation = undefined;
        entry.pauses.clear();
        if (isTerminalClosing(entry.record.state)) entry.finalizeClosed();
        else {
          entry.record.state = 'exited';
          this.emitState(entry);
        }
        entry.finishExit();
      })
      .catch(() => {
        entry.record.state = 'cleanup-failed';
        entry.record.errorCode = 'TERMINAL_CLEANUP_FAILED';
        entry.finishExit();
      });
  }

  private async start(
    entry: TerminalInstance,
    attachment: TerminalAttachmentSession,
  ): Promise<void> {
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

  private async receive(
    entry: TerminalInstance,
    attachment: TerminalAttachmentSession,
    raw: unknown,
  ): Promise<void> {
    this.current(entry, attachment);
    const frame = terminalClientFrameSchema.parse(raw);
    if (frame.attachmentId !== attachment.id) throw terminalError('TERMINAL_REPLACED');
    if (frame.type === 'ready') {
      if (frame.seq !== attachment.snapshotSeq) throw terminalError('TERMINAL_PROTOCOL_ERROR');
      if (attachment.readyWork) return attachment.readyWork;
      attachment.readyWork = (async () => {
        if (entry.record.state !== 'exited') await this.start(entry, attachment);
        this.current(entry, attachment);
        attachment.completeReady(
          isTerminalRunning(entry.record, entry.observedExit),
          entry.snapshotRecord(),
        );
      })().catch((error: unknown) => {
        attachment.close(error instanceof AppError ? error.code : 'TERMINAL_START_FAILED');
        throw error;
      });
      return attachment.readyWork;
    }
    if (!attachment.ready) throw terminalError('TERMINAL_NOT_READY');
    if (frame.type === 'outputAck') {
      attachment.acknowledgeOutput(frame.seq);
      return;
    }
    this.session(entry.record.sessionId, true);
    if (!isTerminalRunning(entry.record, entry.observedExit) || !entry.process) {
      throw terminalError('TERMINAL_NOT_RUNNING');
    }
    if (frame.type === 'input') {
      attachment.acceptInputSeq(frame.inputSeq);
      entry.process.write(
        frame.payload.encoding === 'utf8'
          ? frame.payload.data
          : Buffer.from(frame.payload.base64, 'base64'),
      );
      attachment.sendFrame({
        type: 'inputAccepted',
        attachmentId: attachment.id,
        inputSeq: frame.inputSeq,
      });
      return;
    }
    attachment.acceptCommandSeq(frame.commandSeq);
    await entry.enqueue(() => {
      this.current(entry, attachment);
      this.session(entry.record.sessionId, true);
      if (!entry.process || !isTerminalRunning(entry.record, entry.observedExit)) {
        throw terminalError('TERMINAL_NOT_RUNNING');
      }
      entry.screen?.resize(frame.cols, frame.rows);
      entry.process.resize(frame.cols, frame.rows);
      entry.record.cols = frame.cols;
      entry.record.rows = frame.rows;
      entry.seq++;
      attachment.sendFrame({
        type: 'resized',
        attachmentId: attachment.id,
        seq: entry.seq,
        cols: frame.cols,
        rows: frame.rows,
      });
      attachment.sendFrame({
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
      entry = this.createEntry(sessionId, terminalId);
      this.entries.set(terminalId, entry);
    }
    return this.closeEntry(entry);
  }

  private closeEntry(entry: TerminalInstance): Promise<TerminalCloseResponse> {
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
    entry.attachment?.close('TERMINAL_CLOSED');
    entry.pauses.clear();
    try {
      entry.process?.resume();
    } catch {
      entry.record.errorCode = 'TERMINAL_CLEANUP_FAILED';
    }
    const work = (async () => {
      if (!entry.process) {
        entry.finalizeClosed();
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
          entry.finalizeClosed();
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

  hasActiveProcesses(): boolean {
    return [...this.entries.values()].some(({ record }) => terminalHasActiveProcess(record.state));
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
