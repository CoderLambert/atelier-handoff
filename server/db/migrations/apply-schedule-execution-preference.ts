/**
 * @file 装载 v14 定时任务执行环境迁移。
 * @implementation 为 scheduled_tasks 增加 execution_preference 列，支持 project-v1 沙箱与 native-v1 本机项目环境。
 * @updated 2026-11-27T23:05:00+08:00
 */
import { readFileSync } from 'node:fs';

export function applyScheduleExecutionPreference(db: { exec(source: string): unknown }): void {
  db.exec(
    readFileSync(new URL('./0014-schedule-execution-preference.sql', import.meta.url), 'utf8'),
  );
}
