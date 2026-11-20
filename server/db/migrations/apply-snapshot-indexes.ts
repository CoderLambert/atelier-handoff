/**
 * @file 装载会话快照的 v6 数据库迁移。
 * @implementation 在调用方持有的事务内执行随包的固定 SQL 文件，索引和数据库版本一起提交。
 * @updated 2026-11-21T01:00:00+08:00
 */
import { readFileSync } from 'node:fs';

export function applySnapshotIndexes(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0006-session-snapshot-indexes.sql', import.meta.url), 'utf8'));
}
