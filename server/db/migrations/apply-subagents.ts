/**
 * @file 装载子任务记录的 v7 数据库迁移。
 * @implementation 在调用方事务内执行发行包内固定 SQL，原子建立归属约束、索引并更新版本。
 * @updated 2026-11-21T12:00:00+00:00
 */
import { readFileSync } from 'node:fs';

export function applySubagents(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0007-subagents.sql', import.meta.url), 'utf8'));
}
