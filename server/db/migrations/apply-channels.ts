/**
 * @file 装载 v16 外部消息通道迁移。
 * @implementation 在运行时现有事务内执行固定 SQL 创建 channel_bindings 与 channel_sessions 表。
 * @updated 2026-11-28T10:30:00+08:00
 */
import { readFileSync } from 'node:fs';

export function applyChannels(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0016-channels.sql', import.meta.url), 'utf8'));
}
