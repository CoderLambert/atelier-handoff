/**
 * @file 持久化工作台全局配置。
 * @implementation 使用 settings 表的 config 键和 Drizzle 读写，兼容历史未存 limitExecution 的配置项。
 * @updated 2026-11-27T11:20:00-08:00
 */
import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AppConfig } from '../../../shared/types.js';
import { settings } from '../schema/settings.js';

const configKey = 'config';
const defaultMaxTurns = 16;
const defaultTimeoutMs = 300_000;

export function appConfigRepository(db: BetterSQLite3Database) {
  return {
    get(): AppConfig {
      const row = db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, configKey))
        .get();
      if (row) {
        const saved = JSON.parse(row.value) as AppConfig;
        return {
          ...saved,
          // Older settings always saved the numeric defaults, even without user edits.
          limitExecution:
            saved.limitExecution ??
            (saved.maxTurns !== defaultMaxTurns || saved.timeoutMs !== defaultTimeoutMs),
        };
      }
      return {
        gateway: process.env.ATELIER_GATEWAY || 'http://127.0.0.1:3001',
        model: process.env.ATELIER_MODEL || 'gpt-6.1-sol',
        limitExecution: false,
        maxTurns: defaultMaxTurns,
        timeoutMs: defaultTimeoutMs,
      };
    },
    set(config: AppConfig): void {
      const value = JSON.stringify(config);
      db.insert(settings)
        .values({ key: configKey, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } })
        .run();
    },
  };
}
