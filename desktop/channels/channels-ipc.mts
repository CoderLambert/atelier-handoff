/**
 * @file 绑定外部消息通道的受信任 Electron IPC 处理器与状态/配对推送。
 * @implementation 校验渲染进程来源，将通道配置、连接测试、启停、配对审批、解绑与实时事件同步给设置页。
 * @updated 2026-11-28T11:15:00+08:00
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
  pendingPairingSchema,
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

  const sendToRenderer = (channel: string, payload: unknown) => {
    const win = host.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() || host.isStopping()) return;
    win.webContents.send(channel, payload);
  };

  const unbindStatus = manager.onStatusChange((status) => {
    sendToRenderer(desktopChannelsIpc.statusChanged, channelStatusSchema.parse(status));
  });

  const unbindPairing = manager.onPairingRequested((pairing) => {
    sendToRenderer(desktopChannelsIpc.pairingRequested, pendingPairingSchema.parse(pairing));
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

  ipcMain.handle(desktopChannelsIpc.approvePairing, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelPairingActionSchema.parse(input);
    return channelStateSnapshotSchema.parse(
      await manager.approvePairing(parsed.channel, parsed.chatId),
    );
  });

  ipcMain.handle(desktopChannelsIpc.rejectPairing, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelPairingActionSchema.parse(input);
    return channelStateSnapshotSchema.parse(
      await manager.rejectPairing(parsed.channel, parsed.chatId),
    );
  });

  ipcMain.handle(desktopChannelsIpc.unbind, async (event, input: unknown) => {
    assertTrusted(event);
    const parsed = channelPairingActionSchema.parse(input);
    return channelStateSnapshotSchema.parse(
      await manager.unbindAccount(parsed.channel, parsed.chatId),
    );
  });

  return () => {
    unbindStatus();
    unbindPairing();
    ipcMain.removeHandler(desktopChannelsIpc.getState);
    ipcMain.removeHandler(desktopChannelsIpc.saveConfig);
    ipcMain.removeHandler(desktopChannelsIpc.testConnection);
    ipcMain.removeHandler(desktopChannelsIpc.toggle);
    ipcMain.removeHandler(desktopChannelsIpc.approvePairing);
    ipcMain.removeHandler(desktopChannelsIpc.rejectPairing);
    ipcMain.removeHandler(desktopChannelsIpc.unbind);
  };
}
