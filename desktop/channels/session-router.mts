/**
 * @file 维护外部通道聊天与 Atelier 会话的路由映射并拦截基础指令。
 * @implementation 管理 (channel, chatId) -> (atelierSessionId, workspacePath) 持久化映射，在不进入大模型的情况下处理 /new、/stop、/status 指令。
 * @updated 2026-11-28T11:10:00+08:00
 */
import type { ChannelId, ChannelSessionMapping } from '../../shared/channels.js';
import type { InboundMessage } from './types.mjs';

export interface SessionRouterStore {
  getChannelSession(channel: ChannelId, chatId: string): Promise<ChannelSessionMapping | null>;
  upsertChannelSession(input: {
    channel: ChannelId;
    chatId: string;
    atelierSessionId: string;
    workspacePath: string;
    projectId: string;
  }): Promise<ChannelSessionMapping>;
  deleteChannelSession(channel: ChannelId, chatId: string): Promise<boolean>;
  getDefaultWorkspace(): Promise<{ projectId: string; workspacePath: string } | null>;
  createAtelierSession(
    projectId: string,
    title: string,
  ): Promise<{ id: string; projectId: string }>;
}

export interface SessionRunHooks {
  stopActiveRun?(channel: ChannelId, chatId: string): Promise<boolean>;
  isRunActive?(channel: ChannelId, chatId: string): boolean;
}

export type SessionRouteResult =
  | { kind: 'command'; command: '/new' | '/stop' | '/status'; replyText: string }
  | { kind: 'forward'; mapping: ChannelSessionMapping; text: string };

export function parseSlashCommand(text: string): '/new' | '/stop' | '/status' | null {
  const firstToken = text.trim().split(/\s+/)[0] ?? '';
  const normalized = firstToken.replace(/@[\w_]+$/u, '').toLowerCase();
  if (normalized === '/new' || normalized === '/stop' || normalized === '/status') {
    return normalized;
  }
  return null;
}

export class SessionRouter {
  private hooks: SessionRunHooks = {};

  constructor(private readonly store: SessionRouterStore) {}

  setRunHooks(hooks: SessionRunHooks): void {
    this.hooks = hooks;
  }

  async resolveOrCreateSession(
    channel: ChannelId,
    chatId: string,
    senderName: string,
  ): Promise<ChannelSessionMapping> {
    const existing = await this.store.getChannelSession(channel, chatId);
    if (existing) return existing;
    return this.createFreshSession(channel, chatId, senderName);
  }

  private async createFreshSession(
    channel: ChannelId,
    chatId: string,
    senderName: string,
    preferredWorkspace?: { projectId: string; workspacePath: string },
  ): Promise<ChannelSessionMapping> {
    const workspace = preferredWorkspace ?? (await this.store.getDefaultWorkspace());
    if (!workspace) {
      throw new Error('Atelier 尚未添加任何工作区项目，请先在桌面端添加一个项目后再试。');
    }
    const title = `Telegram · ${senderName || chatId}`;
    const created = await this.store.createAtelierSession(workspace.projectId, title);
    return this.store.upsertChannelSession({
      channel,
      chatId,
      atelierSessionId: created.id,
      workspacePath: workspace.workspacePath,
      projectId: workspace.projectId,
    });
  }

  async routeMessage(message: InboundMessage): Promise<SessionRouteResult> {
    const command = parseSlashCommand(message.text);

    if (command === '/new') {
      const previous = await this.store.getChannelSession(message.channel, message.chatId);
      const preferredWorkspace = previous
        ? { projectId: previous.projectId, workspacePath: previous.workspacePath }
        : undefined;
      const fresh = await this.createFreshSession(
        message.channel,
        message.chatId,
        message.senderName,
        preferredWorkspace,
      );
      return {
        kind: 'command',
        command: '/new',
        replyText: [
          '✨ 已开启新会话。',
          `会话 ID：${fresh.atelierSessionId.slice(0, 8)}`,
          `工作区：${fresh.workspacePath}`,
        ].join('\n'),
      };
    }

    if (command === '/stop') {
      const stopped = (await this.hooks.stopActiveRun?.(message.channel, message.chatId)) ?? false;
      return {
        kind: 'command',
        command: '/stop',
        replyText: stopped
          ? '⏹️ 已发送中止请求，正在停止当前任务。'
          : 'ℹ️ 当前没有正在执行的任务。',
      };
    }

    if (command === '/status') {
      const existing = await this.store.getChannelSession(message.channel, message.chatId);
      const running = this.hooks.isRunActive?.(message.channel, message.chatId) ?? false;
      const lines = [
        '📊 当前通道状态',
        `运行状态：${running ? '执行中' : '空闲'}`,
        existing
          ? `当前会话：${existing.atelierSessionId.slice(0, 8)}`
          : '当前会话：尚未创建（发送任意消息或 /new 自动创建）',
        ...(existing ? [`工作区：${existing.workspacePath}`] : []),
      ];
      return {
        kind: 'command',
        command: '/status',
        replyText: lines.join('\n'),
      };
    }

    const mapping = await this.resolveOrCreateSession(
      message.channel,
      message.chatId,
      message.senderName,
    );
    return {
      kind: 'forward',
      mapping,
      text: message.text,
    };
  }
}
