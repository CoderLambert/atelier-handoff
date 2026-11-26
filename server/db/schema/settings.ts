/**
 * @file 声明工作台既有的 SQLite 设置表。
 * @implementation 以键定位设置，值由各功能仓储按独立契约解析。
 * @updated 2026-11-26T13:40:00Z
 */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
