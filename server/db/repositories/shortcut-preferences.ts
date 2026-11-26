/**
 * @file 读写独立的工作台快捷偏好。
 * @implementation 在现有设置表原子保存完整覆盖项，缺失或损坏时回退到快捷默认值。
 * @updated 2026-11-26T13:40:00Z
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  defaultShortcutPreferences,
  shortcutPreferencesSchema,
  type ShortcutPreferences,
} from '../../../shared/shortcuts.js';
import { settings } from '../schema/settings.js';

const preferencesKey = 'shortcut-preferences-v1';

export function shortcutPreferencesRepository(db: BetterSQLite3Database) {
  return {
    read(): ShortcutPreferences {
      const row = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, preferencesKey))
        .get();
      if (row) {
        try {
          const parsed = shortcutPreferencesSchema.safeParse(JSON.parse(row.value));
          if (parsed.success) return parsed.data;
        } catch {
          // Invalid stored JSON falls back to defaults.
        }
      }
      return { ...defaultShortcutPreferences, bindings: {}, navigation: {} };
    },
    save(preferences: ShortcutPreferences): ShortcutPreferences {
      const validated = shortcutPreferencesSchema.parse(preferences);
      const value = JSON.stringify(validated);
      db.insert(settings)
        .values({ key: preferencesKey, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
      return validated;
    },
  };
}
