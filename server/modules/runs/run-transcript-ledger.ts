/**
 * @file 持有单轮运行的转录顺位、工具公告和通知。
 * @implementation 将 SDK 转录增量批量写入宿主事务，协调工具 Hook 和流帧到达顺序，并在原运行收尾事务中补齐顺位。
 * @updated 2026-11-27T18:02:17+08:00
 */
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  finalizeRunTranscript,
  type RunTranscript as TranscriptState,
  type TranscriptNotice,
} from '../../../shared/ordered-transcript.js';
import type { Message, ToolCall } from '../../../shared/types.js';
import { RunTranscript } from '../../run-transcript.js';

type ToolOrders = Pick<ToolCall, 'transcriptOrder' | 'transcriptHookOrder'>;
type NoticePosition = Pick<TranscriptNotice, 'order' | 'at'>;
type FlushTimer = ReturnType<typeof setInterval>;

export interface RunTranscriptLedgerHost {
  transaction(write: () => void): void;
  saveTranscript(state: TranscriptState): void;
  updateMessage(
    id: string,
    changes: Partial<Pick<Message, 'text' | 'transcriptParts' | 'transcriptOrder'>>,
  ): void;
  insertTool(tool: ToolCall): void;
  updateToolPosition(id: string, position: ToolOrders): void;
  emitMessageDelta(id: string): void;
  emitToolAnnounced(id: string, name: string): void;
  now(): string;
}

interface FlushOptions {
  flushIntervalMs?: number;
  setInterval?: (flush: () => void, intervalMs: number) => FlushTimer;
  clearInterval?: (timer: FlushTimer) => void;
}

export class RunTranscriptLedger {
  private readonly transcript = new RunTranscript();
  private readonly transcriptNotices: TranscriptNotice[] = [];
  private readonly recordedNotices = new Set<string>();
  private readonly pendingDenials = new Map<
    string,
    Extract<TranscriptNotice, { kind: 'tool_blocked' }>
  >();
  private readonly seenTools = new Set<string>();
  private readonly unpositionedTools = new Map<string, number>();
  private flushTimer?: FlushTimer;
  private disposed = false;

  constructor(
    private readonly host: RunTranscriptLedgerHost,
    private readonly options: FlushOptions = {},
  ) {}

  initialize(promptMessageId: string | undefined, createAssistant: () => string): string {
    const initialOrder = this.transcript.nextOrder();
    this.host.transaction(() => {
      this.saveTranscript();
      if (promptMessageId)
        this.host.updateMessage(promptMessageId, { transcriptOrder: initialOrder });
    });
    const assistantId = createAssistant();
    this.transcript.associateInput(promptMessageId, assistantId);
    return assistantId;
  }

  startFlushing(): void {
    if (this.disposed || this.flushTimer !== undefined) return;
    const schedule = this.options.setInterval ?? setInterval;
    this.flushTimer = schedule(() => this.flush(), this.options.flushIntervalMs ?? 80);
  }

  flush(): void {
    const changes = this.transcript.takeChanges();
    if (!changes.length) return;
    this.host.transaction(() => {
      for (const { id, text, transcriptParts } of changes) {
        this.host.updateMessage(id, { text, transcriptParts });
        this.host.emitMessageDelta(id);
      }
    });
  }

  recordUserInput(messageId: string, persistInput: (order: number) => string): string {
    this.flush();
    const assistantId = persistInput(this.transcript.nextOrder());
    this.transcript.associateInput(messageId, assistantId);
    return assistantId;
  }

  acknowledgeInput(messageId: string): void {
    this.transcript.acknowledgeInput(messageId);
  }

  acceptStream(
    message: SDKPartialAssistantMessage,
    assistantId: string,
    appToolId: (id: string) => string,
  ): void {
    this.transcript.acceptStream(message, assistantId, appToolId);
    this.publishToolPositions();
  }

  acceptAssistant(
    message: SDKAssistantMessage,
    assistantId: string,
    appToolId: (id: string) => string,
  ): string {
    const owner = this.transcript.acceptAssistant(message, assistantId, appToolId);
    this.publishToolPositions();
    return owner;
  }

  fallback(assistantId: string, result: string): void {
    this.transcript.fallback(assistantId, result);
  }

  recordNotice(key: string, buildNotice: (position: NoticePosition) => TranscriptNotice): void {
    // Reserve the observation's order even when its notice is a duplicate.
    const position = { order: this.transcript.nextOrder(), at: this.host.now() };
    if (this.recordedNotices.has(key)) return;
    const notice = buildNotice(position);
    this.flush();
    this.recordedNotices.add(key);
    this.transcriptNotices.push(notice);
    this.saveTranscript();
  }

  recordBlockedTool(id: string, name: string): void {
    if (this.seenTools.has(id) || this.pendingDenials.has(id)) return;
    if (this.transcriptNotices[this.toolNoticeIndex(id)]?.kind === 'tool_blocked') return;
    const at = this.host.now();
    const position = this.toolPosition(id);
    if (!position) {
      this.pendingDenials.set(id, {
        kind: 'tool_blocked',
        toolCallId: id,
        toolName: name,
        order: this.transcript.nextOrder(),
        at,
      });
    } else {
      this.placeToolNotice(id, name, position.order, at, 'tool_blocked');
    }
    this.saveTranscript();
  }

  toolPosition(id: string) {
    return this.transcript.toolPosition(id);
  }

  hasSeenTool(id: string): boolean {
    return this.seenTools.has(id);
  }

  createTool(id: string, topLevel: boolean, buildTool: (orders: ToolOrders) => ToolCall): ToolCall {
    const value = buildTool(topLevel ? this.assignToolOrder(id) : {});
    const noticeIndex = this.toolNoticeIndex(id);
    this.host.transaction(() => {
      this.host.insertTool(value);
      const removedDenial = this.pendingDenials.delete(id);
      if (noticeIndex !== -1) this.transcriptNotices.splice(noticeIndex, 1);
      if (noticeIndex !== -1 || removedDenial) this.saveTranscript();
    });
    this.seenTools.add(id);
    return value;
  }

  // Stop periodic writes and persist the last batch before the runner closes the SDK.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer !== undefined) {
      const cancel = this.options.clearInterval ?? clearInterval;
      cancel(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }

  // The caller includes position updates and the returned snapshot in its finishing transaction.
  finalize(): TranscriptState {
    this.dispose();
    // A hook whose native frame was lost still has its actual observed position.
    for (const [id, order] of this.unpositionedTools) {
      this.host.updateToolPosition(id, { transcriptOrder: order, transcriptHookOrder: undefined });
    }
    return finalizeRunTranscript(this.state());
  }

  private assignToolOrder(id: string): ToolOrders {
    const position = this.toolPosition(id);
    if (position) return { transcriptOrder: position.order };
    const hookOrder = this.transcript.nextOrder();
    this.unpositionedTools.set(id, hookOrder);
    return { transcriptHookOrder: hookOrder };
  }

  private state(): TranscriptState {
    return {
      version: 1,
      notices: this.transcriptNotices,
      pendingDenials: this.pendingDenials.size ? [...this.pendingDenials.values()] : undefined,
    };
  }

  private saveTranscript(): void {
    this.host.saveTranscript(this.state());
  }

  private toolNoticeIndex(id: string): number {
    return this.transcriptNotices.findIndex(
      (notice) => 'toolCallId' in notice && notice.toolCallId === id,
    );
  }

  private placeToolNotice(
    id: string,
    name: string,
    order: number,
    at: string,
    kind: 'tool_preparing' | 'tool_blocked',
  ): void {
    const notice = { kind, order, at, toolCallId: id, toolName: name };
    const index = this.toolNoticeIndex(id);
    if (index === -1) this.transcriptNotices.push(notice);
    else this.transcriptNotices[index] = notice;
  }

  private publishToolPositions(): void {
    const observed = this.transcript.takeObservedTools();
    if (!observed.length) return;
    this.flush();
    this.host.transaction(() => {
      for (const { id, name, order, at } of observed) {
        if (this.unpositionedTools.delete(id)) {
          this.host.updateToolPosition(id, {
            transcriptOrder: order,
            transcriptHookOrder: undefined,
          });
        } else {
          const blocked = this.pendingDenials.get(id);
          this.pendingDenials.delete(id);
          this.placeToolNotice(
            id,
            name,
            order,
            blocked?.at ?? at,
            blocked ? 'tool_blocked' : 'tool_preparing',
          );
        }
        this.host.emitToolAnnounced(id, name);
      }
      this.saveTranscript();
    });
  }
}
