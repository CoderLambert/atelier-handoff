/**
 * @file 定义桌面界面语言偏好与窄 IPC 契约。
 * @implementation 共享语言枚举校验持久偏好及 IPC 请求和回复，preload 仅暴露读取与保存。
 * @updated 2026-11-22T16:00:00+08:00
 */
import { z } from 'zod';
import { uiLocaleSchema, type UiLocale } from './i18n/locale.js';

export const desktopUiLanguageChannels = {
  get: 'atelier-ui-language:get',
  set: 'atelier-ui-language:set',
} as const;

export const desktopUiLanguageGetSchema = z.undefined();
export const desktopUiLanguageSetSchema = uiLocaleSchema;
export const desktopUiLanguageResultSchema = uiLocaleSchema;
export const desktopUiLanguagePreferenceSchema = z.strictObject({
  formatVersion: z.literal(1),
  locale: uiLocaleSchema,
});

export type DesktopUiLanguageBridge = {
  get(): Promise<UiLocale>;
  set(locale: UiLocale): Promise<UiLocale>;
};
