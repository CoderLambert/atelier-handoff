/**
 * @file 持久化全局任务规划设置及模型覆盖。
 * @implementation 在现有 settings 表使用版本键，读取时校验 JSON 并为缺失或损坏的设置提供默认值。
 * @updated 2026-11-28T21:12:24+08:00
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  taskPlanningSettingsSchema,
  type TaskPlanningSettings,
} from '../../../shared/task-planning.js';
import { settings } from '../schema/settings.js';

const key = 'task-planning-v1';

export function taskPlanningRepository(db: BetterSQLite3Database) {
  return {
    read(): TaskPlanningSettings {
      const row = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key))
        .get();
      if (row) {
        try {
          const result = taskPlanningSettingsSchema.safeParse(JSON.parse(row.value));
          if (result.success) return result.data;
        } catch {
          // Corrupt JSON falls back to the same defaults as an unset preference.
        }
      }
      return { mode: 'auto', prompt: null, modelOverrides: [] };
    },
    save(preferences: TaskPlanningSettings): TaskPlanningSettings {
      const value = JSON.stringify(preferences);
      db.insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value },
        })
        .run();
      return preferences;
    },
  };
}
