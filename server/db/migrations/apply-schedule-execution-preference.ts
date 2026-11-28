/**
 * @file 装载 v14 定时任务执行环境迁移。
 * @implementation 幂等为 scheduled_tasks 增加 execution_preference 列并推进至 Schema v14。
 * @updated 2026-11-27T23:15:00+08:00
 */
import { readFileSync } from 'node:fs';
import type { LegacyDatabase } from '../connection.js';

export function applyScheduleExecutionPreference(
  db: Pick<LegacyDatabase, 'prepare' | 'exec'>,
): void {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(scheduled_tasks)')
      .all()
      .map((row) => String(row.name)),
  );
  if (columns.has('execution_preference')) {
    db.exec('PRAGMA user_version=14;');
    return;
  }
  db.exec(
    readFileSync(new URL('./0014-schedule-execution-preference.sql', import.meta.url), 'utf8'),
  );
}
