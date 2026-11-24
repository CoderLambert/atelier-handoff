/**
 * @file 持久化独立的 AI 多提交模型与推理偏好。
 * @implementation 通过 settings 的独立键读写严格校验的完整偏好对象，缺失或无效数据回退为自动选择。
 * @updated 2026-11-25T00:11:59+08:00
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import {
  gitMultiCommitPreferences,
  type GitMultiCommitPreferences,
} from '../../../shared/git-multi-commit.js';

const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
const preferencesKey = 'git-multi-commit-preferences-v1';

export function gitMultiCommitPreferencesRepository(db: BetterSQLite3Database) {
  return {
    read(): GitMultiCommitPreferences {
      const row = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, preferencesKey))
        .get();
      if (row) {
        try {
          const saved = gitMultiCommitPreferences.safeParse(JSON.parse(row.value));
          if (saved.success) return saved.data;
        } catch {
          // Invalid preferences fall back to automatic selection.
        }
      }
      return { model: null, effort: null };
    },
    save(preferences: GitMultiCommitPreferences): GitMultiCommitPreferences {
      const saved = gitMultiCommitPreferences.parse(preferences);
      const value = JSON.stringify(saved);
      db.insert(settings)
        .values({ key: preferencesKey, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
      return saved;
    },
  };
}
