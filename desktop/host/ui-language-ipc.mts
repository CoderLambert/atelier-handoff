/**
 * @file 绑定可信工作台的语言偏好 IPC。
 * @implementation 复用统一的可信偏好绑定器校验窗口、连接和关停状态，并返回对称清理函数。
 * @updated 2026-11-27T22:00:00+08:00
 */
import type { BrowserWindow } from 'electron';
import {
  desktopUiLanguageChannels,
  desktopUiLanguageGetSchema,
  desktopUiLanguageResultSchema,
  desktopUiLanguageSetSchema,
} from '../../shared/desktop-ui-language.js';
import type { DesktopUiLanguagePreferences } from './ui-language.mjs';
import { bindTrustedPreferenceIpc } from './trusted-ipc.mjs';

type Connection = { origin: string };

export function bindUiLanguage(
  preferences: DesktopUiLanguagePreferences,
  getWindow: () => BrowserWindow | undefined,
  getConnection: () => Connection | undefined,
  isStopping: () => boolean,
): () => void {
  const { unbind } = bindTrustedPreferenceIpc({
    channels: desktopUiLanguageChannels,
    getSchema: desktopUiLanguageGetSchema,
    setSchema: desktopUiLanguageSetSchema,
    resultSchema: desktopUiLanguageResultSchema,
    preferences,
    getWindow,
    getConnection,
    isStopping,
    messages: {
      invalidSource: 'Untrusted UI language request.',
      connectionChanged: 'UI language request connection changed.',
    },
  });
  return unbind;
}
