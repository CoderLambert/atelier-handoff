/**
 * @file 绑定可信工作台的界面主题偏好 IPC。
 * @implementation 复用统一的可信偏好绑定器并在保存后同步更新窗口背景色，返回对称清理函数。
 * @updated 2026-11-27T22:00:00+08:00
 */
import type { BrowserWindow } from 'electron';
import {
  desktopUiThemeChannels,
  desktopUiThemeGetSchema,
  desktopUiThemeResultSchema,
  desktopUiThemeSetSchema,
  uiThemeBackgroundColors,
} from '../../shared/desktop-ui-theme.js';
import type { DesktopUiThemePreferences } from './ui-theme.mjs';
import { bindTrustedPreferenceIpc } from './trusted-ipc.mjs';

type Connection = { origin: string };

export function bindUiTheme(
  preferences: DesktopUiThemePreferences,
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  const { unbind } = bindTrustedPreferenceIpc({
    channels: desktopUiThemeChannels,
    getSchema: desktopUiThemeGetSchema,
    setSchema: desktopUiThemeSetSchema,
    resultSchema: desktopUiThemeResultSchema,
    preferences,
    getWindow,
    getConnection,
    isStopping,
    messages: {
      invalidSource: 'Untrusted UI theme request.',
      connectionChanged: 'UI theme request connection changed.',
    },
    afterSet: (result, owner) => {
      owner.setBackgroundColor(uiThemeBackgroundColors[result]);
    },
  });
  return unbind;
}
