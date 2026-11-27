/**
 * @file 验证桌面系统托盘关闭拦截策略、内嵌图标数据与偏好持久化兼容性。
 * @implementation 覆盖纯关闭判定边界、PNG 图标头校验及旧版 ui-notifications.json 向前兼容读写。
 * @updated 2026-11-27T23:50:00+08:00
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  defaultDesktopUiNotifications,
  desktopUiNotificationPreferenceSchema,
  resolveDesktopUiNotifications,
} from '../shared/desktop-ui-notifications.js';
import {
  TRAY_ICON_PNG_BASE64,
  shouldHideWindowOnClose,
  shouldKeepAliveWhenWindowsClosed,
} from '../desktop/host/tray-policy.mjs';
import {
  DesktopUiNotificationsPreferences,
  desktopUiNotificationsFilename,
} from '../desktop/host/ui-notifications.mjs';

test('tray close policy only hides window when tray is available, enabled, and not quitting', () => {
  assert.equal(
    shouldHideWindowOnClose({
      stopping: false,
      quitting: false,
      trayAvailable: true,
      minimizeToTrayOnClose: true,
    }),
    true,
  );
  assert.equal(
    shouldKeepAliveWhenWindowsClosed({
      stopping: false,
      quitting: false,
      trayAvailable: true,
      minimizeToTrayOnClose: true,
    }),
    true,
  );
  assert.equal(
    shouldHideWindowOnClose({
      stopping: false,
      quitting: false,
      trayAvailable: true,
      minimizeToTrayOnClose: false,
    }),
    false,
  );
  assert.equal(
    shouldHideWindowOnClose({
      stopping: false,
      quitting: false,
      trayAvailable: false,
      minimizeToTrayOnClose: true,
    }),
    false,
  );
  assert.equal(
    shouldHideWindowOnClose({
      stopping: true,
      quitting: false,
      trayAvailable: true,
      minimizeToTrayOnClose: true,
    }),
    false,
  );
  assert.equal(
    shouldHideWindowOnClose({
      stopping: false,
      quitting: true,
      trayAvailable: true,
      minimizeToTrayOnClose: true,
    }),
    false,
  );
});

test('embedded tray icon decodes to a valid 32x32 PNG image', () => {
  const buffer = Buffer.from(TRAY_ICON_PNG_BASE64, 'base64');
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  // IHDR width and height at bytes 16..24
  assert.equal(buffer.readUInt32BE(16), 32);
  assert.equal(buffer.readUInt32BE(20), 32);
});

test('desktop notification preferences preserve backward compatibility for minimizeToTrayOnClose', async () => {
  assert.equal(defaultDesktopUiNotifications.minimizeToTrayOnClose, false);

  const legacyParsed = desktopUiNotificationPreferenceSchema.parse({
    formatVersion: 1,
    notifications: {
      soundTheme: 'chime',
      completionSound: true,
      failureSound: false,
      focusOnCompletion: true,
      volume: 65,
    },
  });
  assert.equal(legacyParsed.notifications.minimizeToTrayOnClose, false);

  const resolvedInvalid = resolveDesktopUiNotifications({
    soundTheme: 'ping',
    minimizeToTrayOnClose: 'yes',
  });
  assert.equal(resolvedInvalid.minimizeToTrayOnClose, false);
  assert.equal(resolvedInvalid.soundTheme, 'ping');

  const dir = await mkdtemp(join(tmpdir(), 'atelier-tray-pref-'));
  try {
    await writeFile(
      join(dir, desktopUiNotificationsFilename),
      JSON.stringify({
        formatVersion: 1,
        notifications: {
          soundTheme: 'codex',
          completionSound: true,
          failureSound: true,
          focusOnCompletion: true,
          volume: 80,
        },
      }),
    );
    const prefs = new DesktopUiNotificationsPreferences(dir);
    const loaded = await prefs.load();
    assert.equal(loaded.minimizeToTrayOnClose, false);

    const updated = await prefs.set({ ...loaded, minimizeToTrayOnClose: true });
    assert.equal(updated.minimizeToTrayOnClose, true);

    const reloaded = new DesktopUiNotificationsPreferences(dir);
    assert.equal((await reloaded.load()).minimizeToTrayOnClose, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
