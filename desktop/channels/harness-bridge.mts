/**
 * @file 桥接外部消息通道与现有 Atelier Agent Harness。
 * @implementation 按 chatId 维护轻量串行队列，发送「思考中...」占位消息，按 1200ms 节流编辑流式输出，超 3800 字符自动分片新发，支持 /stop 立即中止。
 * @updated 2026-11-28T11:45:00+08:00
 */
import {
  splitTelegramMessage,
  TELEGRAM_STREAM_CHUNK_LENGTH,
  type ChannelId,
  type ChannelSessionMapping,
} from '../../shared/channels.js';
import type { RunEvent } from '../../shared/types.js';
import type { ChannelAdapter, InboundMessage } from './types.mjs';

export const STREAM_EDIT_THROTTLE_MS = 1200;
export const THINKING_PLACEHOLDER = '思考中...';

export interface HarnessBridgeClient {
  startSessionMessage(sessionId: string, text: string): Promise<{ runId: string }>;
  stopRun(runId: string): Promise<void>;
  getAssistantText(sessionId: string, runId: string): Promise<string>;
  subscribeEvents(onEvent: (event: RunEvent) => void): () => void;
}

interface ActiveRunEntry {
  runId: string;
  aborted: boolean;
}

function chatKey(channel: ChannelId, chatId: string): string {
  return `${channel}:${chatId}`;
}

export class HarnessBridge {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRunEntry>();

  constructor(
    private readonly client: HarnessBridgeClient,
    private readonly throttleMs: number = STREAM_EDIT_THROTTLE_MS,
    private readonly chunkLength: number = TELEGRAM_STREAM_CHUNK_LENGTH,
  ) {}

  isRunActive(channel: ChannelId, chatId: string): boolean {
    return this.activeRuns.has(chatKey(channel, chatId));
  }

  async stopActiveRun(channel: ChannelId, chatId: string): Promise<boolean> {
    const entry = this.activeRuns.get(chatKey(channel, chatId));
    if (!entry) return false;
    entry.aborted = true;
    await this.client.stopRun(entry.runId);
    return true;
  }

  enqueue(
    message: InboundMessage,
    mapping: ChannelSessionMapping,
    adapter: ChannelAdapter,
  ): Promise<void> {
    const key = chatKey(message.channel, message.chatId);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.executeTurn(message, mapping, adapter));
    const tracked = task.finally(() => {
      if (this.queues.get(key) === tracked) {
        this.queues.delete(key);
      }
    });
    this.queues.set(key, tracked);
    return tracked;
  }

  private async executeTurn(
    message: InboundMessage,
    mapping: ChannelSessionMapping,
    adapter: ChannelAdapter,
  ): Promise<void> {
    const key = chatKey(message.channel, message.chatId);
    const sentMessageIds: string[] = [];
    const lastRenderedChunks: string[] = [];

    const placeholder = await adapter.send(message.chatId, THINKING_PLACEHOLDER);
    sentMessageIds.push(placeholder.messageId);
    lastRenderedChunks.push(THINKING_PLACEHOLDER);

    const renderText = async (fullText: string): Promise<void> => {
      const normalized = fullText.trim() || THINKING_PLACEHOLDER;
      const chunks = splitTelegramMessage(normalized, this.chunkLength);
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i] ?? '';
        if (i < sentMessageIds.length) {
          if (lastRenderedChunks[i] !== chunk) {
            await adapter.edit(message.chatId, sentMessageIds[i]!, chunk);
            lastRenderedChunks[i] = chunk;
          }
        } else {
          const sent = await adapter.send(message.chatId, chunk);
          sentMessageIds.push(sent.messageId);
          lastRenderedChunks.push(chunk);
        }
      }
    };

    let runId: string;
    let unsubscribe: (() => void) | undefined;
    let throttleTimer: ReturnType<typeof setTimeout> | undefined;
    let flushing = false;
    let dirty = false;
    let finished = false;
    let finishStatus = 'completed';
    let finishReason: string | undefined;

    let resolveDone!: () => void;
    const donePromise = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const flushProgress = async () => {
      if (flushing || finished) return;
      flushing = true;
      dirty = false;
      try {
        const latest = await this.client.getAssistantText(mapping.atelierSessionId, runId);
        if (latest.trim()) {
          await renderText(latest);
        }
      } catch (error) {
        console.warn('[channels] Failed to refresh streaming output:', error);
      } finally {
        flushing = false;
        if (dirty && !finished) {
          scheduleThrottle();
        }
      }
    };

    const scheduleThrottle = () => {
      dirty = true;
      if (throttleTimer || finished) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = undefined;
        void flushProgress();
      }, this.throttleMs);
    };

    try {
      // Subscribe before starting the run so fast completions are never missed.
      let targetRunId: string | undefined;
      const bufferedEvents: RunEvent[] = [];

      const handleEvent = (event: RunEvent) => {
        if (!targetRunId) {
          bufferedEvents.push(event);
          return;
        }
        if (event.runId !== targetRunId) return;
        if (event.type === 'message.delta') {
          scheduleThrottle();
        } else if (event.type === 'run.finished') {
          finished = true;
          finishStatus =
            typeof event.payload?.status === 'string' ? event.payload.status : 'completed';
          finishReason =
            typeof event.payload?.reason === 'string' ? event.payload.reason : undefined;
          if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = undefined;
          }
          resolveDone();
        }
      };

      unsubscribe = this.client.subscribeEvents(handleEvent);
      const started = await this.client.startSessionMessage(mapping.atelierSessionId, message.text);
      runId = started.runId;
      targetRunId = runId;
      this.activeRuns.set(key, { runId, aborted: false });

      for (const buffered of bufferedEvents.splice(0)) {
        handleEvent(buffered);
      }

      await donePromise;

      const entry = this.activeRuns.get(key);
      const finalText = await this.client
        .getAssistantText(mapping.atelierSessionId, runId)
        .catch(() => '');

      if (finalText.trim()) {
        const suffix =
          entry?.aborted || finishStatus === 'canceled'
            ? '\n\n⏹️（已中止）'
            : finishStatus === 'failed' && finishReason
              ? `\n\n⚠️ 执行失败：${finishReason}`
              : '';
        await renderText(`${finalText.trim()}${suffix}`);
      } else if (entry?.aborted || finishStatus === 'canceled') {
        await renderText('⏹️ 任务已中止。');
      } else if (finishStatus === 'failed') {
        await renderText(`⚠️ 任务执行失败：${finishReason || '请查看桌面端执行轨迹。'}`);
      } else {
        await renderText('✅ 任务已完成（无文本输出）。');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : '执行失败。';
      await renderText(`⚠️ 无法启动或完成任务：${msg}`).catch(() => {});
    } finally {
      if (throttleTimer) clearTimeout(throttleTimer);
      unsubscribe?.();
      this.activeRuns.delete(key);
    }
  }
}
