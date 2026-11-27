/**
 * @file 绑定桌面通知偏好与窗口唤醒 IPC。
 * @implementation 复用统一的可信偏好绑定器处理通知偏好读写，并绑定窗口激活通道及对称清理函数。
 * @updated 2026-11-27T22:00:00+08:00
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
import { bindTrustedPreferenceIpc } from './trusted-ipc.mjs';

type Connection = { origin: string };

export function bindUiNotifications(
  preferences: DesktopUiNotificationsPreferences,
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  const { assertTrustedIpc, unbind } = bindTrustedPreferenceIpc({
    channels: desktopUiNotificationChannels,
    getSchema: desktopUiNotificationGetSchema,
    setSchema: desktopUiNotificationSetSchema,
    resultSchema: desktopUiNotificationResultSchema,
    preferences,
    getWindow,
    getConnection,
    isStopping,
    messages: {
      invalidSource: 'Untrusted UI notifications request.',
      connectionChanged: 'UI notifications request connection changed.',
    },
  });

  ipcMain.handle(desktopUiNotificationChannels.focusWindow, (event) => {
    const { owner } = assertTrustedIpc(event);
    focusWindow(owner);
    if (!owner.isFocused()) owner.flashFrame(true);
    return desktopWindowFocusResultSchema.parse({ focused: true });
  });

  return () => {
    unbind();
    ipcMain.removeHandler(desktopUiNotificationChannels.focusWindow);
  };
}
