/**
 * @file 装载 v12 定时任务迁移。
 * @implementation 在运行时现有事务内执行固定 SQL 创建定时任务与运行记录表。
 * @updated 2026-11-27T13:05:00+08:00
 */
import { readFileSync } from 'node:fs';

export function applyScheduledTasks(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0012-scheduled-tasks.sql', import.meta.url), 'utf8'));
}
