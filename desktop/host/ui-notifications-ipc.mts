/**
 * @file 绑定桌面通知偏好与窗口唤醒 IPC。
 * @implementation 校验主窗口、origin 与发送 frame，处理通知偏好读写与焦点恢复。
 * @updated 2026-11-23T15:35:00+08:00
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  desktopUiNotificationChannels,
  desktopUiNotificationGetSchema,
  desktopUiNotificationResultSchema,
  desktopUiNotificationSetSchema,
  desktopWindowFocusResultSchema,
} from '../../shared/desktop-ui-notifications.js';
import { focusWindow } from './window.mjs';
import type { DesktopUiNotificationsPreferences } from './ui-notifications.mjs';

type Connection = { origin: string };

export function bindUiNotifications(
  preferences: DesktopUiNotificationsPreferences,
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  function trusted(event: IpcMainInvokeEvent): Connection {
    const owner = getWindow();
    const connection = getConnection();
    if (
      isStopping() ||
      !owner ||
      owner.isDestroyed() ||
      !connection ||
      owner.webContents.isDestroyed() ||
      event.sender !== owner.webContents ||
      event.senderFrame !== owner.webContents.mainFrame ||
      event.senderFrame?.origin !== connection.origin
    )
      throw new Error('Untrusted UI notifications request.');
    return connection;
  }

  ipcMain.handle(desktopUiNotificationChannels.get, (event, input: unknown) => {
    trusted(event);
    desktopUiNotificationGetSchema.parse(input);
    return desktopUiNotificationResultSchema.parse(preferences.get());
  });

  ipcMain.handle(desktopUiNotificationChannels.set, async (event, input: unknown) => {
    const connection = trusted(event);
    const notifications = desktopUiNotificationSetSchema.parse(input);
    const result = await preferences.set(notifications, () => {
      if (trusted(event) !== connection)
        throw new Error('UI notifications request connection changed.');
    });
    trusted(event);
    return desktopUiNotificationResultSchema.parse(result);
  });

  ipcMain.handle(desktopUiNotificationChannels.focusWindow, (event) => {
    trusted(event);
    const owner = getWindow();
    if (owner && !owner.isDestroyed()) {
      focusWindow(owner);
      if (!owner.isFocused()) {
        owner.flashFrame(true);
      }
    }
    return desktopWindowFocusResultSchema.parse({ focused: true });
  });

  return () => {
    ipcMain.removeHandler(desktopUiNotificationChannels.get);
    ipcMain.removeHandler(desktopUiNotificationChannels.set);
    ipcMain.removeHandler(desktopUiNotificationChannels.focusWindow);
  };
}
