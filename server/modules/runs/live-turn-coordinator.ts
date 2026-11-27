/**
 * @file 管理单轮 SDK 流的实时插话与输入排空。
 * @implementation 维护输入槽、前台任务交接与回执，按执行模式等待空闲或结算；通过运行宿主回调写入消息与发布事件。
 * @updated 2026-11-27T17:49:36+08:00
 */
import { randomUUID } from 'node:crypto';
import type {
  Query,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { AppError } from '../../../shared/types.js';
import type { NativeBashTasks } from '../../native-bash.js';
import type { SubagentRun } from '../../subagent-run.js';

export type AttachmentImages = {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string };
}[];

export interface LiveInput {
  id: NonNullable<SDKUserMessage['uuid']>;
  text: string;
  priority?: 'next' | 'now';
  canDispatch?(): boolean;
  dispatched(): void;
  confirmed(): void;
  released(): void;
}

export class InputQueue {
  private readonly values: SDKUserMessage[] = [];
  private ended = false;
  private wake?: () => void;

  push(
    text: string,
    images: AttachmentImages = [],
    uuid: NonNullable<SDKUserMessage['uuid']> = randomUUID(),
    priority?: LiveInput['priority'],
  ) {
    this.values.push({
      type: 'user',
      message: {
        role: 'user',
        content: images.length ? [{ type: 'text', text }, ...images] : text,
      },
      parent_tool_use_id: null,
      uuid,
      ...(priority && {
        priority,
        origin: { kind: 'human' as const },
        client_composed: true as const,
      }),
    });
    this.wake?.();
  }

  end() {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const value = this.values.shift();
      if (value) {
        yield value;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

export function sdkInputIds(message: {
  user_message_uuid?: string;
  user_message_uuids?: string[];
}) {
  return (
    message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [])
  );
}

type Receipt = 'replay' | 'reply' | 'result';
type BackgroundControl = Pick<Query, 'backgroundTasks' | 'stopTask'>;
type TimerHandle = ReturnType<typeof setTimeout> | number;
type ResultAction = 'continue' | 'finish' | 'unfinished-subagents';

interface LiveTurnOptions {
  native: boolean;
  sdkSessionId: string;
  signal: AbortSignal;
  liveInput: { insert?: (message: LiveInput) => void | Promise<void> };
  runningTools: ReadonlyMap<string, { useId?: string; subagentId?: string }>;
  subagents: Pick<
    SubagentRun,
    'active' | 'hasBackground' | 'isBackground' | 'canMove' | 'moveToBackground'
  >;
  bash?: Pick<NativeBashTasks, 'hasDeferredReceipt' | 'isBackground' | 'canMove' | 'control'>;
  blockedByLocalWork(): boolean;
  onInputCheckpoint?(): void;
  persistInput(message: LiveInput): void;
  publishInput(messageId: string): void;
  acknowledgeTranscriptInput(messageId: string): void;
  event(type: 'sdk.input_confirmed', payload: { messageId: string; receipt: Receipt }): void;
  idleTimeoutMs?: number;
  setTimeout?(callback: () => void, delay: number): TimerHandle;
  clearTimeout?(handle: TimerHandle): void;
}

export class LiveTurnCoordinator {
  private readonly queue = new InputQueue();
  private readonly idleTimeoutMs: number;
  private readonly scheduleTimeout: NonNullable<LiveTurnOptions['setTimeout']>;
  private readonly cancelTimeout: NonNullable<LiveTurnOptions['clearTimeout']>;
  private insertion?: { message: LiveInput; sent: boolean; preparing: boolean };
  private awaitingResultFor?: string;
  private insertionIdleTimer?: TimerHandle;
  private atToolBoundary = false;
  private awaitingModel = true;
  private sdkSessionIdle = false;
  private drainingInput = false;
  private initialized = false;
  private closing = false;
  private finalResult?: SDKResultMessage;

  constructor(private readonly options: LiveTurnOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
  }

  get input(): AsyncIterable<SDKUserMessage> {
    return this.queue;
  }

  get isClosing() {
    return this.closing;
  }

  get isDrainingInput() {
    return this.drainingInput;
  }

  get wasInitialized() {
    return this.initialized;
  }

  get result() {
    return this.finalResult;
  }

  enqueueInitialPrompt(text: string, images?: AttachmentImages, uuid?: LiveInput['id']) {
    this.queue.push(text, images, uuid);
  }

  onInitialized(sdk: BackgroundControl) {
    const firstInit = !this.initialized;
    this.initialized = true;
    if (!this.drainingInput && !this.closing)
      this.options.liveInput.insert = (message) => this.insert(message, sdk);
    return firstInit;
  }

  onToolBoundary() {
    this.atToolBoundary = true;
  }

  onModelStarted() {
    this.atToolBoundary = false;
    this.awaitingModel = true;
  }

  onSessionStateChanged(sessionId: string, state: SDKSessionStateChangedMessage['state']) {
    if (!this.options.native || sessionId !== this.options.sdkSessionId) return;
    this.sdkSessionIdle = state === 'idle';
    if (!this.sdkSessionIdle) this.clearInputIdleTimer();
    else this.afterDeferredWork();
  }

  hasLiveInputSlot() {
    return !this.insertion;
  }

  canInsertNow() {
    // This checks whether foreground work can move. Slot ownership is checked separately.
    return (
      !this.options.blockedByLocalWork() &&
      this.foregroundTools().every((id) => this.canBackground(id))
    );
  }

  canInsertNext() {
    return (
      !!this.options.liveInput.insert &&
      !this.insertion &&
      !this.options.blockedByLocalWork() &&
      (!this.awaitingModel || this.atToolBoundary) &&
      !this.foregroundTools().length
    );
  }

  private foregroundTools() {
    const { runningTools, bash, subagents } = this.options;
    return [...runningTools]
      .filter(
        ([id, { subagentId }]) =>
          !subagentId && !bash?.isBackground(id) && !subagents.isBackground(id),
      )
      .map(([id]) => id);
  }

  private canBackground(id: string) {
    const { runningTools, bash, subagents } = this.options;
    const useId = runningTools.get(id)?.useId;
    return (
      !!useId &&
      (subagents.canMove(id) || bash?.canMove(id)) &&
      [...runningTools.values()].filter((call) => call.useId === useId).length === 1
    );
  }

  async insert(message: LiveInput, sdk: BackgroundControl) {
    if (this.insertion)
      throw new AppError('LIVE_INPUT_BUSY', '上一条补充消息还在处理，请稍后再插入。', 409);
    const current = { message, sent: false, preparing: true };
    this.insertion = current;
    const { bash, subagents, runningTools, signal } = this.options;
    try {
      if (bash && (message.priority ?? 'now') === 'now') {
        if (!this.canInsertNow())
          throw new AppError('LIVE_INPUT_UNAVAILABLE', '当前步骤需要先停止本轮。', 409);
        if (message.canDispatch?.() === false)
          throw new AppError('QUEUE_CHANGED', '队列或执行范围已变化。', 409);
        for (const id of this.foregroundTools()) {
          signal.throwIfAborted();
          if (!runningTools.has(id) || bash.isBackground(id) || subagents.isBackground(id))
            continue;
          if (!this.canBackground(id))
            throw new AppError('LIVE_INPUT_UNAVAILABLE', '当前运行无法插入消息。', 409);
          if (subagents.canMove(id)) await subagents.moveToBackground(sdk, id);
          else await bash.control(sdk, id, 'background');
        }
      }
      current.preparing = false;
      this.sendInsertion();
    } catch (error) {
      if (this.insertion === current) this.insertion = undefined;
      throw error;
    }
  }

  sendInsertion() {
    const { bash, signal } = this.options;
    if (
      this.closing ||
      signal.aborted ||
      !this.initialized ||
      this.options.blockedByLocalWork() ||
      (bash && this.foregroundTools().length)
    )
      return;
    if (!this.insertion) {
      if (bash && (!this.awaitingModel || this.atToolBoundary)) this.options.onInputCheckpoint?.();
      return;
    }
    if (this.insertion.sent || this.insertion.preparing) return;
    const { message } = this.insertion;
    if (message.canDispatch?.() === false) {
      this.insertion = undefined;
      message.released();
      return;
    }
    message.dispatched();
    this.insertion.sent = true;
    this.options.persistInput(message);
    this.awaitingModel = true;
    this.sdkSessionIdle = false;
    if (this.options.native) this.clearInputIdleTimer();
    this.queue.push(message.text, [], message.id, message.priority ?? 'now');
    this.options.publishInput(message.id);
  }

  acknowledgeInsertion(sessionId: string | undefined, ids: readonly string[], receipt: Receipt) {
    if (
      this.options.signal.aborted ||
      sessionId !== this.options.sdkSessionId ||
      !this.insertion?.sent
    )
      return;
    const { message } = this.insertion;
    if (!ids.includes(message.id)) return;
    message.confirmed();
    this.options.acknowledgeTranscriptInput(message.id);
    this.awaitingResultFor = message.id;
    this.insertion = undefined;
    this.clearInputIdleTimer();
    this.options.event('sdk.input_confirmed', { messageId: message.id, receipt });
  }

  hasUnsettledInput() {
    return Boolean(this.insertion || this.awaitingResultFor);
  }

  onFinalResult(result: SDKResultMessage) {
    this.finalResult = result;
    this.awaitingModel = false;
    const ids = sdkInputIds(result);
    if (!result.is_error) this.acknowledgeInsertion(result.session_id, ids, 'result');
    if (
      result.session_id === this.options.sdkSessionId &&
      this.awaitingResultFor &&
      ids.includes(this.awaitingResultFor)
    ) {
      this.awaitingResultFor = undefined;
      this.clearInputIdleTimer();
    }
    return this.hasUnsettledInput();
  }

  afterResultRecorded(flush: () => void): ResultAction {
    if (this.drainingInput) return 'continue';
    if (this.hasUnsettledInput()) {
      this.sendInsertion();
      this.awaitInputSettlement();
    } else if (this.hasDeferredWork()) {
      flush();
      this.sendInsertion();
    } else if (
      this.options.native &&
      !this.finalResult?.is_error &&
      !this.options.subagents.active
    ) {
      this.afterDeferredWork();
    } else {
      this.options.liveInput.insert = undefined;
      return this.options.subagents.active ? 'unfinished-subagents' : 'finish';
    }
    return 'continue';
  }

  private hasDeferredWork() {
    return this.options.bash?.hasDeferredReceipt || this.options.subagents.hasBackground;
  }

  private drainInput() {
    this.drainingInput = true;
    this.options.liveInput.insert = undefined;
    this.queue.end();
  }

  private clearInputIdleTimer() {
    if (this.insertionIdleTimer === undefined) return;
    this.cancelTimeout(this.insertionIdleTimer);
    this.insertionIdleTimer = undefined;
  }

  private awaitInputSettlement() {
    const { native, bash } = this.options;
    // An older result can arrive while the native CLI is processing a new input.
    if (
      (native && !this.sdkSessionIdle) ||
      !this.hasUnsettledInput() ||
      this.hasDeferredWork() ||
      this.insertionIdleTimer !== undefined
    )
      return;
    this.insertionIdleTimer = this.scheduleTimeout(() => {
      this.insertionIdleTimer = undefined;
      if (
        this.hasUnsettledInput() &&
        (native ? this.sdkSessionIdle : !(this.awaitingResultFor && this.awaitingModel)) &&
        !this.hasDeferredWork() &&
        (!bash || !this.foregroundTools().length)
      )
        this.drainInput();
    }, this.idleTimeoutMs);
  }

  afterDeferredWork() {
    if (this.hasDeferredWork() || !this.finalResult || this.options.subagents.active) return;
    if (this.hasUnsettledInput()) this.awaitInputSettlement();
    else if (this.options.native ? this.sdkSessionIdle : !this.awaitingModel) this.drainInput();
  }

  unsettledInputFailure() {
    if (this.options.signal.aborted) return;
    if (this.insertion?.sent) return '补充消息未收到 SDK 回执。';
    if (this.awaitingResultFor && !this.finalResult?.is_error)
      return 'SDK 连接已结束，但未返回补充消息的终态。';
  }

  onClosing() {
    this.options.liveInput.insert = undefined;
    this.closing = true;
  }

  releaseUnconfirmedInput() {
    this.clearInputIdleTimer();
    this.insertion?.message.released();
    this.insertion = undefined;
  }

  dispose() {
    this.onClosing();
    this.releaseUnconfirmedInput();
    this.queue.end();
  }
}
