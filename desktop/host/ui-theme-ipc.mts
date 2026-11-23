/**
 * @file 绑定可信工作台的界面主题偏好 IPC。
 * @implementation 同时校验拥有窗口、主 frame 和当前运行时 origin，在排队保存及原子提交前复核连接身份。
 * @updated 2026-11-23T14:45:00+08:00
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  desktopUiThemeChannels,
  desktopUiThemeGetSchema,
  desktopUiThemeResultSchema,
  desktopUiThemeSetSchema,
} from '../../shared/desktop-ui-theme.js';
import type { DesktopUiThemePreferences } from './ui-theme.mjs';

type Connection = { origin: string };

export function bindUiTheme(
  preferences: DesktopUiThemePreferences,
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
      throw new Error('Untrusted UI theme request.');
    return connection;
  }

  ipcMain.handle(desktopUiThemeChannels.get, (event, input: unknown) => {
    trusted(event);
    desktopUiThemeGetSchema.parse(input);
    return desktopUiThemeResultSchema.parse(preferences.get());
  });
  ipcMain.handle(desktopUiThemeChannels.set, async (event, input: unknown) => {
    const connection = trusted(event);
    const theme = desktopUiThemeSetSchema.parse(input);
    const result = await preferences.set(theme, () => {
      if (trusted(event) !== connection) throw new Error('UI theme request connection changed.');
    });
    trusted(event);
    return desktopUiThemeResultSchema.parse(result);
  });
  return () => {
    ipcMain.removeHandler(desktopUiThemeChannels.get);
    ipcMain.removeHandler(desktopUiThemeChannels.set);
  };
}
