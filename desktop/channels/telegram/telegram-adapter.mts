/**
 * @file 基于 grammY Long Polling 实现 Telegram Bot 通道适配器。
 * @implementation 封装连接测试（getMe）、启动/优雅停止、4096 字符自动分片发送、消息编辑与 409 Conflict 冲突捕获。
 * @updated 2026-11-28T10:35:00+08:00
 */
import { Bot, GrammyError } from 'grammy';
import {
  splitTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  type ChannelStatus,
  type ChannelTestResult,
} from '../../../shared/channels.js';
import type {
  ChannelAdapter,
  ChannelStatusListener,
  InboundMessage,
  InboundMessageHandler,
  OutboundMessageRef,
} from '../types.mjs';

function formatGrammyError(error: unknown): string {
  if (error instanceof GrammyError) {
    if (error.error_code === 409) {
      return '检测到 409 Conflict：同一 Bot Token 正在另一处轮询，请停止其他实例后重试。';
    }
    if (error.error_code === 401) {
      return 'Bot Token 无效或已被吊销（401 Unauthorized）。';
    }
    return `Telegram API 错误（${error.error_code}）：${error.description}`;
  }
  return error instanceof Error ? error.message : 'Telegram 连接失败。';
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram' as const;
  private bot: Bot | undefined;
  private pollingPromise: Promise<void> | undefined;
  private readonly messageHandlers = new Set<InboundMessageHandler>();
  private readonly statusListeners = new Set<ChannelStatusListener>();
  private status: ChannelStatus = {
    channel: 'telegram',
    state: 'disconnected',
    botUsername: null,
    error: null,
    updatedAt: new Date().toISOString(),
  };

  getStatus(): ChannelStatus {
    return { ...this.status };
  }

  onMessage(handler: InboundMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onStatusChange(listener: ChannelStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(
    state: ChannelStatus['state'],
    botUsername: string | null = this.status.botUsername,
    error: string | null = null,
  ): void {
    this.status = {
      channel: 'telegram',
      state,
      botUsername,
      error,
      updatedAt: new Date().toISOString(),
    };
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('[telegram] Status listener failed:', err);
      }
    }
  }

  async testConnection(token: string): Promise<ChannelTestResult> {
    const trimmed = token.trim();
    if (!trimmed) {
      return { ok: false, botUsername: null, error: '请先输入 Bot Token。' };
    }
    try {
      const probe = new Bot(trimmed);
      const me = await probe.api.getMe();
      const username = me.username ? `@${me.username}` : me.first_name;
      return { ok: true, botUsername: username, error: null };
    } catch (error) {
      return { ok: false, botUsername: null, error: formatGrammyError(error) };
    }
  }

  async start(token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('Bot Token 未配置。');
    await this.stop();
    this.setStatus('connecting', this.status.botUsername, null);

    const bot = new Bot(trimmed);
    let me;
    try {
      me = await bot.api.getMe();
    } catch (error) {
      const message = formatGrammyError(error);
      this.setStatus('error', null, message);
      throw new Error(message);
    }

    const botUsername = me.username ? `@${me.username}` : me.first_name;
    bot.botInfo = me;

    bot.on('message:text', async (ctx) => {
      const text = ctx.message.text?.trim();
      if (!text) return;
      const from = ctx.from;
      const senderName =
        [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim() ||
        from?.username ||
        String(ctx.chat.id);
      const inbound: InboundMessage = {
        channel: 'telegram',
        chatId: String(ctx.chat.id),
        messageId: String(ctx.message.message_id),
        senderId: String(from?.id ?? ctx.chat.id),
        senderName,
        senderUsername: from?.username ? `@${from.username}` : null,
        text,
        receivedAt: new Date(ctx.message.date * 1000).toISOString(),
      };
      for (const handler of this.messageHandlers) {
        try {
          await handler(inbound);
        } catch (error) {
          console.error('[telegram] Inbound message handler failed:', error);
        }
      }
    });

    bot.catch((botError) => {
      const message = formatGrammyError(botError.error);
      console.error('[telegram] Bot runtime error:', message);
      if (botError.error instanceof GrammyError && botError.error.error_code === 409) {
        this.setStatus('error', botUsername, message);
        void this.stopWithError(message);
      }
    });

    this.bot = bot;
    this.setStatus('connected', botUsername, null);

    this.pollingPromise = bot
      .start({
        drop_pending_updates: true,
        onStart: () => {
          if (this.bot === bot) this.setStatus('connected', botUsername, null);
        },
      })
      .catch((error: unknown) => {
        if (this.bot !== bot) return;
        const message = formatGrammyError(error);
        console.error('[telegram] Long polling terminated:', message);
        this.bot = undefined;
        this.pollingPromise = undefined;
        this.setStatus('error', botUsername, message);
      });
  }

  private async stopWithError(message: string): Promise<void> {
    const active = this.bot;
    this.bot = undefined;
    if (active) {
      try {
        await active.stop();
      } catch {
        // Ignore shutdown errors after conflict.
      }
    }
    this.pollingPromise = undefined;
    this.setStatus('error', this.status.botUsername, message);
  }

  async stop(): Promise<void> {
    const active = this.bot;
    const polling = this.pollingPromise;
    this.bot = undefined;
    this.pollingPromise = undefined;
    if (active) {
      try {
        await active.stop();
      } catch {
        // Best-effort graceful stop.
      }
    }
    if (polling) {
      await polling.catch(() => undefined);
    }
    this.setStatus('disconnected', this.status.botUsername, null);
  }

  async send(chatId: string, text: string): Promise<OutboundMessageRef> {
    const active = this.bot;
    if (!active) throw new Error('Telegram Bot 尚未连接。');
    const chunks = splitTelegramMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH);
    let lastMessageId = '';
    for (const chunk of chunks) {
      const sent = await active.api.sendMessage(chatId, chunk);
      lastMessageId = String(sent.message_id);
    }
    return { messageId: lastMessageId };
  }

  async edit(chatId: string, messageId: string, text: string): Promise<void> {
    const active = this.bot;
    if (!active) throw new Error('Telegram Bot 尚未连接。');
    const numericId = Number(messageId);
    if (!Number.isFinite(numericId)) throw new Error('无效的 Telegram 消息 ID。');
    const clipped =
      text.length > TELEGRAM_MAX_MESSAGE_LENGTH ? text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH) : text;
    try {
      await active.api.editMessageText(chatId, numericId, clipped);
    } catch (error) {
      if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        /message is not modified/i.test(error.description)
      ) {
        return;
      }
      throw error;
    }
  }
}
