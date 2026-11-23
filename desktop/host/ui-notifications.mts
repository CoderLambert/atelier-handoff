/**
 * @file 管理桌面通知与提示音偏好的本地 profile 持久化。
 * @implementation 读写原子文件 ui-notifications.json，并在内存维护解析后的 DesktopUiNotifications 偏好。
 * @updated 2026-11-23T15:35:00+08:00
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultDesktopUiNotifications,
  desktopUiNotificationPreferenceSchema,
  resolveDesktopUiNotifications,
  type DesktopUiNotifications,
} from '../../shared/desktop-ui-notifications.js';

export const desktopUiNotificationsFilename = 'ui-notifications.json';

export async function loadDesktopUiNotifications(profile: string): Promise<DesktopUiNotifications> {
  try {
    const raw = await readFile(join(profile, desktopUiNotificationsFilename), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = desktopUiNotificationPreferenceSchema.safeParse(parsed);
    if (result.success) return result.data.notifications;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Failed to read desktop UI notification preferences; using default.', error);
    }
  }
  return defaultDesktopUiNotifications;
}

export class DesktopUiNotificationsPreferences {
  private notifications: DesktopUiNotifications = defaultDesktopUiNotifications;
  private pending: Promise<DesktopUiNotifications> = Promise.resolve(defaultDesktopUiNotifications);

  constructor(private readonly profile: string) {}

  get(): DesktopUiNotifications {
    return this.notifications;
  }

  async load(): Promise<DesktopUiNotifications> {
    this.notifications = await loadDesktopUiNotifications(this.profile);
    return this.notifications;
  }

  async set(
    notifications: DesktopUiNotifications,
    verify?: () => void,
  ): Promise<DesktopUiNotifications> {
    const resolved = resolveDesktopUiNotifications(notifications);
    return this.serialize(async () => {
      verify?.();
      await mkdir(this.profile, { recursive: true, mode: 0o700 });
      const target = join(this.profile, desktopUiNotificationsFilename);
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
      const payload = JSON.stringify({
        formatVersion: 1,
        notifications: resolved,
      });
      try {
        await writeFile(temporary, payload, { mode: 0o600 });
        verify?.();
        await rename(temporary, target);
        this.notifications = resolved;
        return this.notifications;
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  private serialize(
    operation: () => Promise<DesktopUiNotifications>,
  ): Promise<DesktopUiNotifications> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => this.notifications);
    return next;
  }
}
