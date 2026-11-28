/**
 * @file 装载 v13 定时任务统一触发与远程遥控迁移。
 * @implementation 幂等检查列是否已存在以自动修复早期缺少 user_version 推进的本地库，并推进至 Schema v13。
 * @updated 2026-11-27T23:15:00+08:00
 */
import { readFileSync } from 'node:fs';
import type { LegacyDatabase } from '../connection.js';

export function applyScheduleTriggers(db: Pick<LegacyDatabase, 'prepare' | 'exec'>): void {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(scheduled_tasks)')
      .all()
      .map((row) => String(row.name)),
  );
  if (columns.has('slug')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_project_slug
        ON scheduled_tasks(project_id, slug) WHERE slug IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_task_runs_idempotency
        ON scheduled_task_runs(task_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      PRAGMA user_version=13;
    `);
    return;
  }
  db.exec(readFileSync(new URL('./0013-schedule-triggers.sql', import.meta.url), 'utf8'));
}
