/**
 * @file 外部消息通道配对鉴权守卫。
 * @implementation 拦截未绑定 chatId 并生成 6 位数字配对码（内存 Map，TTL 10 分钟），通过事件推送给渲染进程审批；支持批准落库与解绑立即失效。
 * @updated 2026-11-28T11:10:00+08:00
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { ChannelBinding, ChannelId, PendingPairing } from '../../shared/channels.js';
import type { InboundMessage } from './types.mjs';

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

export interface PairingBindingStore {
  listBindings(channel?: ChannelId): Promise<ChannelBinding[]>;
  upsertBinding(input: {
    id: string;
    channel: ChannelId;
    chatId: string;
    label: string;
    username: string | null;
  }): Promise<ChannelBinding>;
  deleteBinding(channel: ChannelId, chatId: string): Promise<boolean>;
}

export type PairingRequestedListener = (pairing: PendingPairing) => void;

export type PairingCheckResult =
  | { allowed: true; binding: ChannelBinding }
  | { allowed: false; pending: PendingPairing; replyText: string };

function pairingKey(channel: ChannelId, chatId: string): string {
  return `${channel}:${chatId}`;
}

export class PairingGuard {
  private readonly pending = new Map<string, PendingPairing>();
  private readonly listeners = new Set<PairingRequestedListener>();

  constructor(
    private readonly store: PairingBindingStore,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = PAIRING_CODE_TTL_MS,
  ) {}

  onPairingRequested(listener: PairingRequestedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitPairingRequested(pairing: PendingPairing): void {
    for (const listener of this.listeners) {
      try {
        listener(pairing);
      } catch (error) {
        console.error('[channels] Pairing listener failed:', error);
      }
    }
  }

  pruneExpired(): void {
    const current = this.now();
    for (const [key, item] of this.pending.entries()) {
      if (Date.parse(item.expiresAt) <= current) {
        this.pending.delete(key);
      }
    }
  }

  listPending(channel?: ChannelId): PendingPairing[] {
    this.pruneExpired();
    const items = Array.from(this.pending.values());
    return channel ? items.filter((item) => item.channel === channel) : items;
  }

  async listBindings(channel?: ChannelId): Promise<ChannelBinding[]> {
    return this.store.listBindings(channel);
  }

  async checkAccess(message: InboundMessage): Promise<PairingCheckResult> {
    const bindings = await this.store.listBindings(message.channel);
    const existingBinding = bindings.find((item) => item.chatId === message.chatId);
    if (existingBinding) {
      return { allowed: true, binding: existingBinding };
    }

    this.pruneExpired();
    const key = pairingKey(message.channel, message.chatId);
    const existingPending = this.pending.get(key);
    const current = this.now();

    const pending: PendingPairing =
      existingPending && Date.parse(existingPending.expiresAt) > current
        ? existingPending
        : {
            channel: message.channel,
            chatId: message.chatId,
            code: String(randomInt(100000, 1000000)),
            senderName: message.senderName,
            senderUsername: message.senderUsername,
            createdAt: new Date(current).toISOString(),
            expiresAt: new Date(current + this.ttlMs).toISOString(),
          };

    this.pending.set(key, pending);
    this.emitPairingRequested(pending);

    const replyText = [
      '🔐 此账号尚未与本地 Atelier 绑定。',
      `配对码：${pending.code}`,
      '请在桌面端 Atelier「设置 → 消息通道」中核对并批准配对（10 分钟内有效）。',
    ].join('\n');

    return { allowed: false, pending, replyText };
  }

  async approve(channel: ChannelId, chatId: string): Promise<ChannelBinding> {
    this.pruneExpired();
    const key = pairingKey(channel, chatId);
    const item = this.pending.get(key);
    if (!item) {
      throw new Error('配对请求不存在或已过期，请让对方重新发送消息获取新配对码。');
    }
    const label = item.senderUsername
      ? `${item.senderName} (@${item.senderUsername})`
      : item.senderName || chatId;
    const binding = await this.store.upsertBinding({
      id: randomUUID(),
      channel,
      chatId,
      label,
      username: item.senderUsername,
    });
    this.pending.delete(key);
    return binding;
  }

  reject(channel: ChannelId, chatId: string): boolean {
    return this.pending.delete(pairingKey(channel, chatId));
  }

  async unbind(channel: ChannelId, chatId: string): Promise<boolean> {
    this.pending.delete(pairingKey(channel, chatId));
    return this.store.deleteBinding(channel, chatId);
  }
}
