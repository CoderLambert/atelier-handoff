/**
 * @file 定义桌面通知与提示音偏好及 IPC 契约。
 * @implementation 共享 Zod schema 校验持久偏好与请求响应，preload 仅暴露偏好读写和窗口唤醒。
 * @updated 2026-11-27T23:50:00+08:00
 */
import { z } from 'zod';

export const soundThemes = ['codex', 'chime', 'marimba', 'bubble', 'ping'] as const;
export type SoundTheme = (typeof soundThemes)[number];

export const desktopUiNotificationsSchema = z.strictObject({
  soundTheme: z.enum(soundThemes),
  completionSound: z.boolean(),
  failureSound: z.boolean(),
  focusOnCompletion: z.boolean(),
  minimizeToTrayOnClose: z.boolean().default(false),
  volume: z.number().int().min(0).max(100),
});

export type DesktopUiNotifications = z.infer<typeof desktopUiNotificationsSchema>;

export const defaultDesktopUiNotifications: DesktopUiNotifications = {
  soundTheme: 'codex',
  completionSound: true,
  failureSound: true,
  focusOnCompletion: true,
  minimizeToTrayOnClose: false,
  volume: 80,
};

export function resolveDesktopUiNotifications(value: unknown): DesktopUiNotifications {
  const result = desktopUiNotificationsSchema.safeParse(value);
  if (result.success) return result.data;
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    const soundTheme =
      typeof candidate.soundTheme === 'string' &&
      (soundThemes as readonly string[]).includes(candidate.soundTheme)
        ? (candidate.soundTheme as SoundTheme)
        : defaultDesktopUiNotifications.soundTheme;
    return {
      soundTheme,
      completionSound:
        typeof candidate.completionSound === 'boolean'
          ? candidate.completionSound
          : defaultDesktopUiNotifications.completionSound,
      failureSound:
        typeof candidate.failureSound === 'boolean'
          ? candidate.failureSound
          : defaultDesktopUiNotifications.failureSound,
      focusOnCompletion:
        typeof candidate.focusOnCompletion === 'boolean'
          ? candidate.focusOnCompletion
          : defaultDesktopUiNotifications.focusOnCompletion,
      minimizeToTrayOnClose:
        typeof candidate.minimizeToTrayOnClose === 'boolean'
          ? candidate.minimizeToTrayOnClose
          : defaultDesktopUiNotifications.minimizeToTrayOnClose,
      volume:
        typeof candidate.volume === 'number' && candidate.volume >= 0 && candidate.volume <= 100
          ? Math.round(candidate.volume)
          : defaultDesktopUiNotifications.volume,
    };
  }
  return defaultDesktopUiNotifications;
}

export const desktopUiNotificationChannels = {
  get: 'atelier-ui-notifications:get',
  set: 'atelier-ui-notifications:set',
  focusWindow: 'atelier-window:focus',
} as const;

export const desktopUiNotificationGetSchema = z.undefined();
export const desktopUiNotificationSetSchema = desktopUiNotificationsSchema;
export const desktopUiNotificationResultSchema = desktopUiNotificationsSchema;
export const desktopUiNotificationPreferenceSchema = z.strictObject({
  formatVersion: z.literal(1),
  notifications: desktopUiNotificationsSchema,
});

export const desktopWindowFocusResultSchema = z.strictObject({
  focused: z.boolean(),
});

export type DesktopUiNotificationsBridge = {
  get(): Promise<DesktopUiNotifications>;
  set(notifications: DesktopUiNotifications): Promise<DesktopUiNotifications>;
  focusWindow(): Promise<{ focused: boolean }>;
};
