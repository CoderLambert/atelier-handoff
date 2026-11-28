/**
 * @file 通道适配器注册表与生命周期管理器。
 * @implementation 不直接依赖任何协议库（如 grammY），统一管理配置、密文 Token、启停恢复与状态事件广播。
 * @updated 2026-11-28T10:35:00+08:00
 */
import {
  maskBotToken,
  type ChannelConfig,
  type ChannelConfigUpdate,
  type ChannelId,
  type ChannelStateSnapshot,
  type ChannelStatus,
  type ChannelTestResult,
} from '../../shared/channels.js';
import type { ChannelConfigStore } from './config-store.mjs';
import type { ChannelSecretStore } from './secret-store.mjs';
import type {
  ChannelAdapter,
  ChannelStatusListener,
  InboundMessage,
  InboundMessageHandler,
} from './types.mjs';

export class ChannelManager {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();
  private readonly statusListeners = new Set<ChannelStatusListener>();
  private readonly unsubscribes: (() => void)[] = [];
  private inboundHandler: InboundMessageHandler | undefined;

  constructor(
    private readonly secrets: ChannelSecretStore,
    private readonly configs: ChannelConfigStore,
  ) {}

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.unsubscribes.push(
      adapter.onStatusChange((status) => {
        for (const listener of this.statusListeners) {
          try {
            listener(status);
          } catch (error) {
            console.error('[channels] Status listener failed:', error);
          }
        }
      }),
    );
    this.unsubscribes.push(
      adapter.onMessage(async (message) => {
        await this.handleInbound(message);
      }),
    );
  }

  setInboundHandler(handler: InboundMessageHandler | undefined): void {
    this.inboundHandler = handler;
  }

  onStatusChange(listener: ChannelStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getAdapter(channel: ChannelId): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new Error(`未注册的消息通道：${channel}`);
    return adapter;
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    if (this.inboundHandler) {
      await this.inboundHandler(message);
      return;
    }
    // Batch 1 default connectivity verification: echo back inbound messages.
    const adapter = this.adapters.get(message.channel);
    if (!adapter) return;
    try {
      await adapter.send(message.chatId, `Echo: ${message.text}`);
    } catch (error) {
      console.error(`[channels] Echo reply failed for ${message.channel}:`, error);
    }
  }

  async restoreEnabledChannels(): Promise<void> {
    await this.configs.load();
    for (const [channel] of this.adapters) {
      const cfg = this.configs.get(channel);
      if (!cfg.enabled) continue;
      const token = await this.secrets.getToken(channel);
      if (!token) continue;
      try {
        await this.startChannel(channel);
      } catch (error) {
        console.error(`[channels] Failed to restore ${channel}:`, error);
      }
    }
  }

  async getConfig(channel: ChannelId): Promise<ChannelConfig> {
    const stored = this.configs.get(channel);
    const token = await this.secrets.getToken(channel);
    return {
      channel,
      enabled: stored.enabled,
      hasToken: Boolean(token),
      maskedToken: token ? maskBotToken(token) : '',
      botUsername: stored.botUsername,
      pushScheduleResults: stored.pushScheduleResults,
    };
  }

  getStatus(channel: ChannelId): ChannelStatus {
    return this.getAdapter(channel).getStatus();
  }

  async getStateSnapshot(channel: ChannelId): Promise<ChannelStateSnapshot> {
    return {
      config: await this.getConfig(channel),
      status: this.getStatus(channel),
      pendingPairings: [],
      bindings: [],
    };
  }

  async testConnection(channel: ChannelId, tokenOverride?: string): Promise<ChannelTestResult> {
    const adapter = this.getAdapter(channel);
    const token = tokenOverride?.trim() || (await this.secrets.getToken(channel)) || '';
    const result = await adapter.testConnection(token);
    if (result.ok && result.botUsername) {
      await this.configs.update(channel, { botUsername: result.botUsername });
    }
    return result;
  }

  async saveConfig(input: ChannelConfigUpdate): Promise<ChannelStateSnapshot> {
    const { channel } = input;
    if (input.clearToken) {
      await this.stopChannel(channel);
      await this.secrets.deleteToken(channel);
      await this.configs.update(channel, { enabled: false, botUsername: null });
    } else if (input.token !== undefined && input.token.trim().length > 0) {
      await this.secrets.setToken(channel, input.token.trim());
    }

    const patch: Partial<{ enabled: boolean; pushScheduleResults: boolean }> = {};
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.pushScheduleResults !== undefined)
      patch.pushScheduleResults = input.pushScheduleResults;
    if (Object.keys(patch).length > 0) {
      await this.configs.update(channel, patch);
    }

    const current = this.configs.get(channel);
    if (current.enabled) {
      const token = await this.secrets.getToken(channel);
      if (token) {
        await this.startChannel(channel);
      } else {
        await this.configs.update(channel, { enabled: false });
      }
    } else if (input.enabled === false) {
      await this.stopChannel(channel);
    }

    return this.getStateSnapshot(channel);
  }

  async toggleChannel(channel: ChannelId, enabled: boolean): Promise<ChannelStateSnapshot> {
    if (enabled) {
      const token = await this.secrets.getToken(channel);
      if (!token) throw new Error('请先保存有效的 Bot Token。');
      await this.configs.update(channel, { enabled: true });
      try {
        await this.startChannel(channel);
      } catch (error) {
        await this.configs.update(channel, { enabled: false });
        throw error;
      }
    } else {
      await this.configs.update(channel, { enabled: false });
      await this.stopChannel(channel);
    }
    return this.getStateSnapshot(channel);
  }

  async startChannel(channel: ChannelId): Promise<void> {
    const adapter = this.getAdapter(channel);
    const token = await this.secrets.getToken(channel);
    if (!token) throw new Error('Bot Token 未配置。');
    await adapter.start(token);
    const status = adapter.getStatus();
    if (status.botUsername) {
      await this.configs.update(channel, { botUsername: status.botUsername });
    }
  }

  async stopChannel(channel: ChannelId): Promise<void> {
    const adapter = this.adapters.get(channel);
    if (!adapter) return;
    await adapter.stop();
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.stop().catch(() => undefined)),
    );
    while (this.unsubscribes.length > 0) {
      this.unsubscribes.pop()?.();
    }
  }
}
