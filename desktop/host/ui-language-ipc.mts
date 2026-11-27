/**
 * @file 绑定可信工作台的语言偏好 IPC。
 * @implementation 通过共享来源守卫校验窗口、连接和关停状态，在排队保存及原子提交前复核连接身份。
 * @updated 2026-11-27T16:55:43+08:00
 */
import { ipcMain, type BrowserWindow } from 'electron';
import {
  desktopUiLanguageChannels,
  desktopUiLanguageGetSchema,
  desktopUiLanguageResultSchema,
  desktopUiLanguageSetSchema,
} from '../../shared/desktop-ui-language.js';
import type { DesktopUiLanguagePreferences } from './ui-language.mjs';
import { createTrustedIpcGuard } from './trusted-ipc.mjs';

type Connection = { origin: string };

export function bindUiLanguage(
  preferences: DesktopUiLanguagePreferences,
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  const assertTrustedIpc = createTrustedIpcGuard(
    getWindow,
    getConnection,
    isStopping,
    () => 'Untrusted UI language request.',
  );

  ipcMain.handle(desktopUiLanguageChannels.get, (event, input: unknown) => {
    assertTrustedIpc(event);
    desktopUiLanguageGetSchema.parse(input);
    return desktopUiLanguageResultSchema.parse(preferences.get());
  });
  ipcMain.handle(desktopUiLanguageChannels.set, async (event, input: unknown) => {
    const { connection } = assertTrustedIpc(event);
    const locale = desktopUiLanguageSetSchema.parse(input);
    const result = await preferences.set(locale, () => {
      if (assertTrustedIpc(event).connection !== connection)
        throw new Error('UI language request connection changed.');
    });
    assertTrustedIpc(event);
    return desktopUiLanguageResultSchema.parse(result);
  });
  return () => {
    ipcMain.removeHandler(desktopUiLanguageChannels.get);
    ipcMain.removeHandler(desktopUiLanguageChannels.set);
  };
}
