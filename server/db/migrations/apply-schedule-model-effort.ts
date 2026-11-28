/**
 * @file 装载 v15 定时任务模型与推理强度迁移。
 * @implementation 幂等为 scheduled_tasks 增加 model 与 effort 列并推进至 Schema v15。
 * @updated 2026-11-27T23:45:00+08:00
 */
import { readFileSync } from 'node:fs';
import type { LegacyDatabase } from '../connection.js';

export function applyScheduleModelEffort(db: Pick<LegacyDatabase, 'prepare' | 'exec'>): void {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(scheduled_tasks)')
      .all()
      .map((row) => String(row.name)),
  );
  if (columns.has('model') && columns.has('effort')) {
    db.exec('PRAGMA user_version=15;');
    return;
  }
  db.exec(readFileSync(new URL('./0015-schedule-model-effort.sql', import.meta.url), 'utf8'));
}
