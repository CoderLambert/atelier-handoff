/**
 * @file 持久化 Skill 工具绑定配置。
 * @implementation 使用 settings 表与 Drizzle 按项目与 Skill 键读写绑定 JSON。
 * @updated 2026-11-27T12:15:00-06:00
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { settings } from '../schema/settings.js';

const bindingKey = (projectId: string, skillId: string) =>
  `skill-tool-bindings:${projectId}:${skillId}`;

export function skillToolBindingsRepository(db: BetterSQLite3Database) {
  return {
    has(projectId: string, skillId: string): boolean {
      const row = db
        .select({ key: settings.key })
        .from(settings)
        .where(eq(settings.key, bindingKey(projectId, skillId)))
        .get();
      return Boolean(row);
    },
    read(projectId: string, skillId: string): string | undefined {
      return db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, bindingKey(projectId, skillId)))
        .get()?.value;
    },
    save(projectId: string, skillId: string, value: string): void {
      const key = bindingKey(projectId, skillId);
      db.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    },
  };
}
