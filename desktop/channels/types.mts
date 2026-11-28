/**
 * @file 定义外部消息通道适配器接口与消息模型。
 * @implementation 解耦 ChannelManager 与具体协议实现（如 grammY），统一入站、出站、编辑与状态监听契约。
 * @updated 2026-11-28T10:35:00+08:00
 */
import type { ChannelId, ChannelStatus, ChannelTestResult } from '../../shared/channels.js';

export interface InboundMessage {
  channel: ChannelId;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  senderUsername: string | null;
  text: string;
  receivedAt: string;
}

export interface OutboundMessageRef {
  messageId: string;
}

export type InboundMessageHandler = (message: InboundMessage) => void | Promise<void>;
export type ChannelStatusListener = (status: ChannelStatus) => void;

export interface ChannelAdapter {
  readonly id: ChannelId;
  start(token: string): Promise<void>;
  stop(): Promise<void>;
  testConnection(token: string): Promise<ChannelTestResult>;
  send(chatId: string, text: string): Promise<OutboundMessageRef>;
  edit(chatId: string, messageId: string, text: string): Promise<void>;
  getStatus(): ChannelStatus;
  onMessage(handler: InboundMessageHandler): () => void;
  onStatusChange(listener: ChannelStatusListener): () => void;
}
