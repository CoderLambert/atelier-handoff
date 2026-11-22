/**
 * @file 持久化本机工作区布局偏好。
 * @implementation 通过现有设置表的独立键读写校验后的布局，不依赖 renderer 的端口。
 * @updated 2026-11-22T00:00:00+08:00
 */
import { eq } from 'drizzle-orm';
import { isWorkspaceLocation, workspaceSessionId } from '../../../shared/workspace-location.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  initialWorkspaceLayout,
  workspaceLayoutSchema,
  type WorkspaceLayout,
} from '../../../shared/workspace-layout.js';

const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
const locationKey = 'workspace-location-v1';
const lastSessionKey = 'workspace-last-session-v1';
const layoutKey = 'workspace-layout-v1';

export function workspaceLayoutRepository(db: BetterSQLite3Database) {
  function readValue(key: string) {
    return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
      ?.value;
  }
  function saveValue(key: string, value: string) {
    db.insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
  return {
    readLocation(): string | undefined {
      const value = readValue(locationKey);
      return value && isWorkspaceLocation(value) ? value : undefined;
    },
    readLastSession(): string | undefined {
      const id = readValue(lastSessionKey);
      return id ? workspaceSessionId(`/sessions/${id}`) : undefined;
    },
    saveLocation(path: string) {
      db.transaction(() => {
        saveValue(locationKey, path);
        const id = workspaceSessionId(path);
        if (id) saveValue(lastSessionKey, id);
      });
      return { path };
    },
    read(): WorkspaceLayout {
      const row = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, layoutKey))
        .get();
      if (row) {
        try {
          const saved = workspaceLayoutSchema.safeParse(JSON.parse(row.value));
          if (saved.success) return saved.data;
        } catch {
          // Invalid preferences fall back to defaults.
        }
      }
      return initialWorkspaceLayout;
    },
    save(layout: WorkspaceLayout): WorkspaceLayout {
      const value = JSON.stringify(layout);
      db.insert(settings)
        .values({ key: layoutKey, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
      return layout;
    },
  };
}
