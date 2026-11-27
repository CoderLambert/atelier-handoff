/**
 * @file 绑定桌面通知偏好与窗口唤醒 IPC。
 * @implementation 通过共享来源守卫校验窗口、连接和关停状态，处理通知偏好读写与焦点恢复。
 * @updated 2026-11-27T16:55:43+08:00
 */
import { ipcMain, type BrowserWindow } from 'electron';
import {
  desktopUiNotificationChannels,
  desktopUiNotificationGetSchema,
  desktopUiNotificationResultSchema,
  desktopUiNotificationSetSchema,
  desktopWindowFocusResultSchema,
} from '../../shared/desktop-ui-notifications.js';
import { focusWindow } from './window.mjs';
import type { DesktopUiNotificationsPreferences } from './ui-notifications.mjs';
import { createTrustedIpcGuard } from './trusted-ipc.mjs';

type Connection = { origin: string };

export function bindUiNotifications(
  preferences: DesktopUiNotificationsPreferences,
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  const assertTrustedIpc = createTrustedIpcGuard(
    getWindow,
    getConnection,
    isStopping,
    () => 'Untrusted UI notifications request.',
  );

  ipcMain.handle(desktopUiNotificationChannels.get, (event, input: unknown) => {
    assertTrustedIpc(event);
    desktopUiNotificationGetSchema.parse(input);
    return desktopUiNotificationResultSchema.parse(preferences.get());
  });

  ipcMain.handle(desktopUiNotificationChannels.set, async (event, input: unknown) => {
    const { connection } = assertTrustedIpc(event);
    const notifications = desktopUiNotificationSetSchema.parse(input);
    const result = await preferences.set(notifications, () => {
      if (assertTrustedIpc(event).connection !== connection)
        throw new Error('UI notifications request connection changed.');
    });
    assertTrustedIpc(event);
    return desktopUiNotificationResultSchema.parse(result);
  });

  ipcMain.handle(desktopUiNotificationChannels.focusWindow, (event) => {
    const { owner } = assertTrustedIpc(event);
    focusWindow(owner);
    if (!owner.isFocused()) owner.flashFrame(true);
    return desktopWindowFocusResultSchema.parse({ focused: true });
  });

  return () => {
    ipcMain.removeHandler(desktopUiNotificationChannels.get);
    ipcMain.removeHandler(desktopUiNotificationChannels.set);
    ipcMain.removeHandler(desktopUiNotificationChannels.focusWindow);
  };
}
