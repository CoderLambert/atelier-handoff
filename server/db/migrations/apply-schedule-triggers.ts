/**
 * @file 装载 v13 定时任务统一触发与远程遥控迁移。
 * @implementation 为 scheduled_tasks 增加别名与单任务远程令牌哈希列，为 scheduled_task_runs 增加幂等键、触发来源与链路深度列。
 * @updated 2026-11-27T15:00:00+08:00
 */
import { readFileSync } from 'node:fs';

export function applyScheduleTriggers(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0013-schedule-triggers.sql', import.meta.url), 'utf8'));
}
