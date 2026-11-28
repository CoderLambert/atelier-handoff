/**
 * @file 定义外部消息通道（Telegram 等）的三端共享类型、校验契约与 IPC 通道名。
 * @implementation 使用 Zod 约束配置、状态、配对与绑定数据结构，并提供 Token 掩码与消息分片纯函数。
 * @updated 2026-11-28T10:30:00+08:00
 */
import { z } from 'zod';

export const channelIdSchema = z.enum(['telegram']);
export type ChannelId = z.infer<typeof channelIdSchema>;

export const channelConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'error',
]);
export type ChannelConnectionState = z.infer<typeof channelConnectionStateSchema>;

export const channelStatusSchema = z.strictObject({
  channel: channelIdSchema,
  state: channelConnectionStateSchema,
  botUsername: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.string(),
});
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const channelConfigSchema = z.strictObject({
  channel: channelIdSchema,
  enabled: z.boolean(),
  hasToken: z.boolean(),
  maskedToken: z.string(),
  botUsername: z.string().nullable(),
  pushScheduleResults: z.boolean(),
});
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

export const channelConfigUpdateSchema = z.strictObject({
  channel: channelIdSchema,
  token: z.string().max(512).optional(),
  clearToken: z.boolean().optional(),
  enabled: z.boolean().optional(),
  pushScheduleResults: z.boolean().optional(),
});
export type ChannelConfigUpdate = z.infer<typeof channelConfigUpdateSchema>;

export const channelTestRequestSchema = z.strictObject({
  channel: channelIdSchema,
  token: z.string().max(512).optional(),
});
export type ChannelTestRequest = z.infer<typeof channelTestRequestSchema>;

export const channelTestResultSchema = z.strictObject({
  ok: z.boolean(),
  botUsername: z.string().nullable(),
  error: z.string().nullable(),
});
export type ChannelTestResult = z.infer<typeof channelTestResultSchema>;

export const pendingPairingSchema = z.strictObject({
  channel: channelIdSchema,
  chatId: z.string().min(1),
  code: z.string().min(4).max(12),
  senderName: z.string(),
  senderUsername: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type PendingPairing = z.infer<typeof pendingPairingSchema>;

export const channelBindingSchema = z.strictObject({
  id: z.string().min(1),
  channel: channelIdSchema,
  chatId: z.string().min(1),
  label: z.string(),
  username: z.string().nullable(),
  createdAt: z.string(),
});
export type ChannelBinding = z.infer<typeof channelBindingSchema>;

export const channelSessionMappingSchema = z.strictObject({
  channel: channelIdSchema,
  chatId: z.string().min(1),
  atelierSessionId: z.string().min(1),
  workspacePath: z.string(),
  projectId: z.string().min(1),
  updatedAt: z.string(),
});
export type ChannelSessionMapping = z.infer<typeof channelSessionMappingSchema>;

export const channelStateSnapshotSchema = z.strictObject({
  config: channelConfigSchema,
  status: channelStatusSchema,
  pendingPairings: z.array(pendingPairingSchema),
  bindings: z.array(channelBindingSchema),
});
export type ChannelStateSnapshot = z.infer<typeof channelStateSnapshotSchema>;

export const channelToggleRequestSchema = z.strictObject({
  channel: channelIdSchema,
  enabled: z.boolean(),
});
export type ChannelToggleRequest = z.infer<typeof channelToggleRequestSchema>;

export const channelPairingActionSchema = z.strictObject({
  channel: channelIdSchema,
  chatId: z.string().min(1),
});
export type ChannelPairingAction = z.infer<typeof channelPairingActionSchema>;

export const desktopChannelsIpc = {
  getState: 'channels:get-state',
  saveConfig: 'channels:save-config',
  testConnection: 'channels:test-connection',
  toggle: 'channels:toggle',
  approvePairing: 'channels:approve-pairing',
  rejectPairing: 'channels:reject-pairing',
  unbind: 'channels:unbind',
  statusChanged: 'channels:status-changed',
  pairingRequested: 'channels:pairing-requested',
} as const;

export interface DesktopChannelsBridge {
  getState(channel: ChannelId): Promise<ChannelStateSnapshot>;
  saveConfig(input: ChannelConfigUpdate): Promise<ChannelStateSnapshot>;
  testConnection(input: ChannelTestRequest): Promise<ChannelTestResult>;
  toggle(input: ChannelToggleRequest): Promise<ChannelStateSnapshot>;
  approvePairing(input: ChannelPairingAction): Promise<ChannelStateSnapshot>;
  rejectPairing(input: ChannelPairingAction): Promise<ChannelStateSnapshot>;
  unbind(input: ChannelPairingAction): Promise<ChannelStateSnapshot>;
  onStatusChanged(callback: (status: ChannelStatus) => void): () => void;
  onPairingRequested(callback: (pairing: PendingPairing) => void): () => void;
}

export function maskBotToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  const colon = trimmed.indexOf(':');
  if (colon > 0 && trimmed.length - colon > 8) {
    const prefix = trimmed.slice(0, colon + 3);
    const suffix = trimmed.slice(-4);
    return `${prefix}••••••${suffix}`;
  }
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••${trimmed.slice(-4)}`;
}

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_STREAM_CHUNK_LENGTH = 3800;

export function splitTelegramMessage(
  text: string,
  maxLength = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (!text) return [''];
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength);
    let splitAt = window.lastIndexOf('\n');
    if (splitAt < Math.floor(maxLength * 0.5)) {
      const spaceAt = window.lastIndexOf(' ');
      if (spaceAt >= Math.floor(maxLength * 0.5)) splitAt = spaceAt;
      else splitAt = maxLength;
    } else {
      splitAt += 1;
    }
    const piece = remaining.slice(0, splitAt);
    if (piece.length > 0) chunks.push(piece);
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
