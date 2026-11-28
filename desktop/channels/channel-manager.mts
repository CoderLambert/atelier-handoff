/**
 * @file 通道适配器注册表与生命周期管理器。
 * @implementation 不直接依赖任何协议库（如 grammY），统一管理配置、密文 Token、配对鉴权、会话路由、启停恢复与状态事件广播。
 * @updated 2026-11-28T11:15:00+08:00
 */
import {
  maskBotToken,
  type ChannelConfig,
  type ChannelConfigUpdate,
  type ChannelId,
  type ChannelSessionMapping,
  type ChannelStateSnapshot,
  type ChannelStatus,
  type ChannelTestResult,
} from '../../shared/channels.js';
import type { ChannelConfigStore } from './config-store.mjs';
import type { PairingGuard, PairingRequestedListener } from './pairing-guard.mjs';
import type { ChannelSecretStore } from './secret-store.mjs';
import type { SessionRouter } from './session-router.mjs';
import type {
  ChannelAdapter,
  ChannelStatusListener,
  InboundMessage,
  InboundMessageHandler,
} from './types.mjs';

export type RoutedInboundHandler = (
  message: InboundMessage,
  mapping: ChannelSessionMapping,
  adapter: ChannelAdapter,
) => Promise<void> | void;

export interface ChannelManagerOptions {
  pairingGuard?: PairingGuard;
  sessionRouter?: SessionRouter;
}

export class ChannelManager {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();
  private readonly statusListeners = new Set<ChannelStatusListener>();
  private readonly unsubscribes: (() => void)[] = [];
  private inboundHandler: InboundMessageHandler | undefined;
  private routedHandler: RoutedInboundHandler | undefined;
  private readonly pairingGuard: PairingGuard | undefined;
  private readonly sessionRouter: SessionRouter | undefined;

  constructor(
    private readonly secrets: ChannelSecretStore,
    private readonly configs: ChannelConfigStore,
    options: ChannelManagerOptions = {},
  ) {
    this.pairingGuard = options.pairingGuard;
    this.sessionRouter = options.sessionRouter;
  }

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

  setRoutedHandler(handler: RoutedInboundHandler | undefined): void {
    this.routedHandler = handler;
  }

  onStatusChange(listener: ChannelStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onPairingRequested(listener: PairingRequestedListener): () => void {
    if (!this.pairingGuard) return () => {};
    return this.pairingGuard.onPairingRequested(listener);
  }

  getAdapter(channel: ChannelId): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) throw new Error(`未注册的消息通道：${channel}`);
    return adapter;
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
    const config = await this.getConfig(channel);
    const pendingPairings = this.pairingGuard ? this.pairingGuard.listPending(channel) : [];
    let bindings: ChannelStateSnapshot['bindings'] = [];
    if (this.pairingGuard) {
      try {
        bindings = await this.pairingGuard.listBindings(channel);
      } catch (error) {
        console.warn('[channels] Failed to load channel bindings:', error);
      }
    }
    return {
      config,
      status: this.getStatus(channel),
      pendingPairings,
      bindings,
    };
  }

  async saveConfig(update: ChannelConfigUpdate): Promise<ChannelStateSnapshot> {
    const { channel } = update;
    const adapter = this.getAdapter(channel);

    if (update.clearToken) {
      await adapter.stop();
      await this.secrets.deleteToken(channel);
      await this.configs.update(channel, { enabled: false, botUsername: null });
    } else if (typeof update.token === 'string' && update.token.trim().length > 0) {
      await this.secrets.setToken(channel, update.token.trim());
    }

    if (typeof update.pushScheduleResults === 'boolean') {
      await this.configs.update(channel, { pushScheduleResults: update.pushScheduleResults });
    }

    if (typeof update.enabled === 'boolean') {
      return this.toggleChannel(channel, update.enabled);
    }

    const current = this.configs.get(channel);
    if (current.enabled && typeof update.token === 'string' && update.token.trim().length > 0) {
      await this.startChannel(channel);
    }

    return this.getStateSnapshot(channel);
  }

  async testConnection(channel: ChannelId, rawToken?: string): Promise<ChannelTestResult> {
    const adapter = this.getAdapter(channel);
    const token = rawToken?.trim() || (await this.secrets.getToken(channel)) || '';
    if (!token) {
      return { ok: false, botUsername: null, error: '请先输入或保存 Bot Token。' };
    }
    const result = await adapter.testConnection(token);
    if (result.ok && result.botUsername) {
      await this.configs.update(channel, { botUsername: result.botUsername });
    }
    return result;
  }

  async toggleChannel(channel: ChannelId, enabled: boolean): Promise<ChannelStateSnapshot> {
    const adapter = this.getAdapter(channel);
    if (!enabled) {
      await this.configs.update(channel, { enabled: false });
      await adapter.stop();
      return this.getStateSnapshot(channel);
    }

    const token = await this.secrets.getToken(channel);
    if (!token) {
      throw new Error('请先保存有效的 Bot Token 后再启用通道。');
    }

    await this.configs.update(channel, { enabled: true });
    await this.startChannel(channel);
    return this.getStateSnapshot(channel);
  }

  async approvePairing(channel: ChannelId, chatId: string): Promise<ChannelStateSnapshot> {
    if (!this.pairingGuard) throw new Error('配对守卫尚未初始化。');
    const binding = await this.pairingGuard.approve(channel, chatId);
    const adapter = this.adapters.get(channel);
    if (adapter && adapter.getStatus().state === 'connected') {
      await adapter
        .send(
          binding.chatId,
          '✅ 配对已批准！你现在可以直接发送消息与本地 Atelier 对话，或使用 /status、/new、/stop 指令。',
        )
        .catch(() => {});
    }
    return this.getStateSnapshot(channel);
  }

  async rejectPairing(channel: ChannelId, chatId: string): Promise<ChannelStateSnapshot> {
    if (!this.pairingGuard) throw new Error('配对守卫尚未初始化。');
    this.pairingGuard.reject(channel, chatId);
    return this.getStateSnapshot(channel);
  }

  async unbindAccount(channel: ChannelId, chatId: string): Promise<ChannelStateSnapshot> {
    if (!this.pairingGuard) throw new Error('配对守卫尚未初始化。');
    await this.pairingGuard.unbind(channel, chatId);
    return this.getStateSnapshot(channel);
  }

  async startChannel(channel: ChannelId): Promise<void> {
    const adapter = this.getAdapter(channel);
    const token = await this.secrets.getToken(channel);
    if (!token) {
      throw new Error('未找到已保存的 Bot Token。');
    }
    await adapter.start(token);
    const status = adapter.getStatus();
    if (status.botUsername) {
      await this.configs.update(channel, { botUsername: status.botUsername });
    }
  }

  async restoreEnabledChannels(): Promise<void> {
    await this.configs.load();
    for (const channel of this.adapters.keys()) {
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

  async stopAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const adapter of this.adapters.values()) {
      tasks.push(
        adapter.stop().catch((error) => {
          console.error(`[channels] Failed to stop ${adapter.id}:`, error);
        }),
      );
    }
    await Promise.all(tasks);
  }

  dispose(): void {
    for (const unsub of this.unsubscribes.splice(0)) unsub();
    this.statusListeners.clear();
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    const adapter = this.getAdapter(message.channel);

    if (this.pairingGuard) {
      const access = await this.pairingGuard.checkAccess(message);
      if (!access.allowed) {
        await adapter.send(message.chatId, access.replyText);
        return;
      }
    }

    if (this.sessionRouter) {
      let routeResult;
      try {
        routeResult = await this.sessionRouter.routeMessage(message);
      } catch (error) {
        const msg = error instanceof Error ? error.message : '会话路由失败。';
        await adapter.send(message.chatId, `⚠️ ${msg}`);
        return;
      }
      if (routeResult.kind === 'command') {
        await adapter.send(message.chatId, routeResult.replyText);
        return;
      }
      if (this.routedHandler) {
        await this.routedHandler(message, routeResult.mapping, adapter);
        return;
      }
      await adapter.send(
        message.chatId,
        `[Atelier] 已路由到会话 ${routeResult.mapping.atelierSessionId.slice(0, 8)}，收到：${message.text}`,
      );
      return;
    }

    if (this.inboundHandler) {
      await this.inboundHandler(message);
      return;
    }

    // Batch 1 Echo fallback when neither PairingGuard nor SessionRouter is attached.
    await adapter.send(message.chatId, `Echo: ${message.text}`);
  }
}
