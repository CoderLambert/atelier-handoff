/**
 * @file 绑定可信工作台的语言偏好 IPC。
 * @implementation 同时校验拥有窗口、主 frame 和当前运行时 origin，在排队保存及原子提交前复核连接身份。
 * @updated 2026-11-22T16:00:00+08:00
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  desktopUiLanguageChannels,
  desktopUiLanguageGetSchema,
  desktopUiLanguageResultSchema,
  desktopUiLanguageSetSchema,
} from '../../shared/desktop-ui-language.js';
import type { DesktopUiLanguagePreferences } from './ui-language.mjs';

type Connection = { origin: string };

export function bindUiLanguage(
  preferences: DesktopUiLanguagePreferences,
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
      throw new Error('Untrusted UI language request.');
    return connection;
  }

  ipcMain.handle(desktopUiLanguageChannels.get, (event, input: unknown) => {
    trusted(event);
    desktopUiLanguageGetSchema.parse(input);
    return desktopUiLanguageResultSchema.parse(preferences.get());
  });
  ipcMain.handle(desktopUiLanguageChannels.set, async (event, input: unknown) => {
    const connection = trusted(event);
    const locale = desktopUiLanguageSetSchema.parse(input);
    const result = await preferences.set(locale, () => {
      if (trusted(event) !== connection) throw new Error('UI language request connection changed.');
    });
    trusted(event);
    return desktopUiLanguageResultSchema.parse(result);
  });
  return () => {
    ipcMain.removeHandler(desktopUiLanguageChannels.get);
    ipcMain.removeHandler(desktopUiLanguageChannels.set);
  };
}
