/**
 * @file 持久化内置 RTK 的全局与项目设置。
 * @implementation 使用 settings 的独立版本键和 Drizzle 读写，缺省启用并跟随全局，损坏的已存值停用。
 * @updated 2026-11-26T01:39:35+08:00
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RtkProjectMode } from '../../../shared/rtk-settings.js';

const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
const globalKey = 'rtk-settings-v1:global';
const projectKey = (projectId: string) => `rtk-settings-v1:project:${JSON.stringify(projectId)}`;

export function rtkSettingsRepository(db: BetterSQLite3Database) {
  function read(key: string): string | undefined {
    return db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
      ?.value;
  }
  function save(key: string, value: string): void {
    db.insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }
  return {
    readGlobal(): boolean {
      const value = read(globalKey);
      return value === undefined || value === 'true';
    },
    setGlobal(enabled: boolean): void {
      save(globalKey, enabled ? 'true' : 'false');
    },
    projectMode(projectId: string): RtkProjectMode {
      const value = read(projectKey(projectId));
      if (value === undefined || value === 'follow') return 'follow';
      return value === 'on' ? 'on' : 'off';
    },
    setProjectMode(projectId: string, mode: RtkProjectMode): void {
      save(projectKey(projectId), mode);
    },
  };
}
