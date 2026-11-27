/**
 * @file 绑定可信工作台的界面主题偏好 IPC。
 * @implementation 通过共享来源守卫校验窗口、连接和关停状态，在排队保存及原子提交前复核连接身份。
 * @updated 2026-11-27T16:55:43+08:00
 */
import { ipcMain, type BrowserWindow } from 'electron';
import {
  desktopUiThemeChannels,
  desktopUiThemeGetSchema,
  desktopUiThemeResultSchema,
  desktopUiThemeSetSchema,
  uiThemeBackgroundColors,
} from '../../shared/desktop-ui-theme.js';
import type { DesktopUiThemePreferences } from './ui-theme.mjs';
import { createTrustedIpcGuard } from './trusted-ipc.mjs';

type Connection = { origin: string };

export function bindUiTheme(
  preferences: DesktopUiThemePreferences,
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  const assertTrustedIpc = createTrustedIpcGuard(
    getWindow,
    getConnection,
    isStopping,
    () => 'Untrusted UI theme request.',
  );

  ipcMain.handle(desktopUiThemeChannels.get, (event, input: unknown) => {
    assertTrustedIpc(event);
    desktopUiThemeGetSchema.parse(input);
    return desktopUiThemeResultSchema.parse(preferences.get());
  });
  ipcMain.handle(desktopUiThemeChannels.set, async (event, input: unknown) => {
    const { connection } = assertTrustedIpc(event);
    const theme = desktopUiThemeSetSchema.parse(input);
    const result = await preferences.set(theme, () => {
      if (assertTrustedIpc(event).connection !== connection)
        throw new Error('UI theme request connection changed.');
    });
    assertTrustedIpc(event);
    getWindow()?.setBackgroundColor(uiThemeBackgroundColors[result]);
    return desktopUiThemeResultSchema.parse(result);
  });
  return () => {
    ipcMain.removeHandler(desktopUiThemeChannels.get);
    ipcMain.removeHandler(desktopUiThemeChannels.set);
  };
}
