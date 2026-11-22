/**
 * @file 定义受支持的界面语言和默认值。
 * @implementation 各运行环境使用同一枚举校验持久偏好和 IPC 数据。
 * @updated 2026-11-22T15:00:00+08:00
 */
import { z } from 'zod';

export const uiLocales = ['zh-CN', 'en'] as const;
export const uiLocaleSchema = z.enum(uiLocales);
export type UiLocale = z.infer<typeof uiLocaleSchema>;
export const defaultUiLocale = 'zh-CN' satisfies UiLocale;

export function resolveUiLocale(value: unknown): UiLocale {
  return uiLocaleSchema.safeParse(value).data ?? defaultUiLocale;
}
