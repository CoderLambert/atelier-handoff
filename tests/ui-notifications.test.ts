/**
 * @file 验证桌面运行提示音与窗口焦点设置的持久化和契约。
 * @implementation 验证默认值、Zod 校验、原子 profile 读写与 IPC 契约。
 * @updated 2026-11-23T15:35:00+08:00
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultDesktopUiNotifications,
  desktopUiNotificationChannels,
  desktopUiNotificationGetSchema,
  desktopUiNotificationPreferenceSchema,
  desktopUiNotificationResultSchema,
  desktopUiNotificationSetSchema,
  desktopUiNotificationsSchema,
  desktopWindowFocusResultSchema,
  resolveDesktopUiNotifications,
} from '../shared/desktop-ui-notifications.js';
import {
  desktopUiNotificationsFilename,
  DesktopUiNotificationsPreferences,
  loadDesktopUiNotifications,
} from '../desktop/host/ui-notifications.mjs';

async function withProfile(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-ui-notifications-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('notification service resolves valid notifications and falls back to default', () => {
  assert.equal(defaultDesktopUiNotifications.soundTheme, 'codex');
  assert.equal(defaultDesktopUiNotifications.completionSound, true);
  assert.equal(defaultDesktopUiNotifications.failureSound, true);
  assert.equal(defaultDesktopUiNotifications.focusOnCompletion, true);
  assert.equal(defaultDesktopUiNotifications.volume, 80);

  const parsed = resolveDesktopUiNotifications({
    soundTheme: 'marimba',
    completionSound: false,
    failureSound: true,
    focusOnCompletion: false,
    volume: 50,
  });
  assert.equal(parsed.soundTheme, 'marimba');
  assert.equal(parsed.completionSound, false);
  assert.equal(parsed.failureSound, true);
  assert.equal(parsed.focusOnCompletion, false);
  assert.equal(parsed.volume, 50);

  // Partial or invalid fallback
  const fallback = resolveDesktopUiNotifications({ soundTheme: 'unknown_theme', volume: 150 });
  assert.equal(fallback.soundTheme, 'codex');
  assert.equal(fallback.completionSound, true);
  assert.equal(fallback.volume, 80);

  assert.deepEqual(resolveDesktopUiNotifications(null), defaultDesktopUiNotifications);
});

test('desktop notifications IPC channels and schemas validate payloads', () => {
  assert.equal(desktopUiNotificationChannels.get, 'atelier-ui-notifications:get');
  assert.equal(desktopUiNotificationChannels.set, 'atelier-ui-notifications:set');
  assert.equal(desktopUiNotificationChannels.focusWindow, 'atelier-window:focus');

  assert.equal(desktopUiNotificationGetSchema.parse(undefined), undefined);
  assert.equal(desktopUiNotificationGetSchema.safeParse({}).success, false);

  const valid = {
    soundTheme: 'codex' as const,
    completionSound: true,
    failureSound: false,
    focusOnCompletion: true,
    minimizeToTrayOnClose: false,
    volume: 60,
  };
  assert.deepEqual(desktopUiNotificationSetSchema.parse(valid), valid);
  assert.deepEqual(desktopUiNotificationResultSchema.parse(valid), valid);
  assert.deepEqual(desktopWindowFocusResultSchema.parse({ focused: true }), { focused: true });
});

test('desktop notifications preference persists in user profile across loads', async () => {
  await withProfile(async (directory) => {
    // 1. Uninitialized profile returns default
    assert.deepEqual(await loadDesktopUiNotifications(directory), defaultDesktopUiNotifications);

    // 2. Preferences instance saves atomically
    const preferences = new DesktopUiNotificationsPreferences(directory);
    await preferences.load();
    assert.deepEqual(preferences.get(), defaultDesktopUiNotifications);

    const custom = {
      soundTheme: 'bubble' as const,
      completionSound: false,
      failureSound: true,
      focusOnCompletion: false,
      minimizeToTrayOnClose: true,
      volume: 45,
    };
    await preferences.set(custom);
    assert.deepEqual(preferences.get(), custom);

    // 3. File was written with formatVersion 1
    const file = join(directory, desktopUiNotificationsFilename);
    const raw = await readFile(file, 'utf8');
    const stored = JSON.parse(raw);
    assert.deepEqual(desktopUiNotificationPreferenceSchema.parse(stored), {
      formatVersion: 1,
      notifications: custom,
    });

    // 4. A new preferences instance reloads the saved notifications
    const reloaded = new DesktopUiNotificationsPreferences(directory);
    await reloaded.load();
    assert.deepEqual(reloaded.get(), custom);
  });
});
