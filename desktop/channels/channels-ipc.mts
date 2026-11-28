/**
 * @file 绑定外部消息通道的受信任 Electron IPC 处理器与状态推送。
 * @implementation 校验渲染进程来源，将通道配置、连接测试、启停与状态变化同步给设置页。
 * @updated 2026-11-28T10:35:00+08:00
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  channelConfigUpdateSchema,
  channelIdSchema,
  channelPairingActionSchema,
  channelStateSnapshotSchema,
  channelStatusSchema,
  channelTestRequestSchema,
  channelTestResultSchema,
  channelToggleRequestSchema,
  desktopChannelsIpc,
} from '../../shared/channels.js';
import type { ChannelManager } from './channel-manager.mjs';

export interface ChannelsIpcHost {
  getWindow(): BrowserWindow | undefined;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  isStopping(): boolean;
}

export function bindChannelsIpc(manager: ChannelManager, host: ChannelsIpcHost): () => void {
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    if (host.isStopping() || !host.isTrustedSender(event)) {
      throw new Error('Untrusted channels IPC request.');
    }
  };

  const unbindStatus = manager.onStatusChange((status) => {
    const win = host.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || host.isStopping()) return;
    win.webContents.send(desktopChannelsIpc.statusChanged, channelStatusSchema.parse(status));
  });

  ipcMain.handle(desktopChannelsIpc.getState, async (event, channelInput: unknown) => {
    assertTrusted(event);
    const channel = channelIdSchema.parse(channelInput);
    return channelStateSnapshotSchema.parse(await manager.getStateSnapshot(channel));
  });

  ipcMain.handle(desktopChannelsIpc.saveConfig, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelConfigUpdateSchema.parse(input);
    return channelStateSnapshotSchema.parse(await manager.saveConfig(parsed));
  });

  ipcMain.handle(desktopChannelsIpc.testConnection, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelTestRequestSchema.parse(input);
    return channelTestResultSchema.parse(
      await manager.testConnection(parsed.channel, parsed.token),
    );
  });

  ipcMain.handle(desktopChannelsIpc.toggle, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelToggleRequestSchema.parse(input);
    return channelStateSnapshotSchema.parse(
      await manager.toggleChannel(parsed.channel, parsed.enabled),
    );
  });

  // Pairing/unbind placeholders keep the shared IPC contract valid until Batch 2 wires PairingGuard.
  ipcMain.handle(desktopChannelsIpc.approvePairing, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelPairingActionSchema.parse(input);
    return channelStateSnapshotSchema.parse(await manager.getStateSnapshot(parsed.channel));
  });

  ipcMain.handle(desktopChannelsIpc.rejectPairing, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelPairingActionSchema.parse(input);
    return channelStateSnapshotSchema.parse(await manager.getStateSnapshot(parsed.channel));
  });

  ipcMain.handle(desktopChannelsIpc.unbind, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelPairingActionSchema.parse(input);
    return channelStateSnapshotSchema.parse(await manager.getStateSnapshot(parsed.channel));
  });

  return () => {
    unbindStatus();
    ipcMain.removeHandler(desktopChannelsIpc.getState);
    ipcMain.removeHandler(desktopChannelsIpc.saveConfig);
    ipcMain.removeHandler(desktopChannelsIpc.testConnection);
    ipcMain.removeHandler(desktopChannelsIpc.toggle);
    ipcMain.removeHandler(desktopChannelsIpc.approvePairing);
    ipcMain.removeHandler(desktopChannelsIpc.rejectPairing);
    ipcMain.removeHandler(desktopChannelsIpc.unbind);
  };
}
