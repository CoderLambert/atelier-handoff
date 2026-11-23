/**
 * @file 定义桌面界面主题偏好与窄 IPC 契约。
 * @implementation 共享主题枚举校验持久偏好及 IPC 请求和回复，preload 仅暴露读取与保存。
 * @updated 2026-11-23T20:05:00+08:00
 */
import { z } from 'zod';

export const allUiThemes = [
  'obsidian',
  'classic',
  'parchment',
  'nordic',
  'rose',
  'midnight',
] as const;

export type UiTheme = (typeof allUiThemes)[number];

export const defaultUiTheme: UiTheme = 'obsidian';

// Keep native window backgrounds aligned with frontend/src/styles.css.
export const uiThemeBackgroundColors: Record<UiTheme, string> = {
  obsidian: '#f9f9fb',
  classic: '#fafbf8',
  parchment: '#fcfbf8',
  nordic: '#f8fafd',
  rose: '#fcf7f2',
  midnight: '#0d1117',
};

export const uiThemeSchema = z.enum(allUiThemes);

export function resolveUiTheme(value: unknown): UiTheme {
  const result = uiThemeSchema.safeParse(value);
  return result.success ? result.data : defaultUiTheme;
}

export const desktopUiThemeChannels = {
  get: 'atelier-ui-theme:get',
  set: 'atelier-ui-theme:set',
} as const;

export const desktopUiThemeGetSchema = z.undefined();
export const desktopUiThemeSetSchema = uiThemeSchema;
export const desktopUiThemeResultSchema = uiThemeSchema;
export const desktopUiThemePreferenceSchema = z.strictObject({
  formatVersion: z.literal(1),
  theme: uiThemeSchema,
});

export type DesktopUiThemeBridge = {
  get(): Promise<UiTheme>;
  set(theme: UiTheme): Promise<UiTheme>;
};
