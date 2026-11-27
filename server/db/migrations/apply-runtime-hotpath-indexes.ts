/**
 * @file 装载运行热路径查询索引的 v11 数据库迁移。
 * @implementation 在调用方持有的事务内执行随包的固定 SQL 文件，派生列、索引和数据库版本一起提交。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { readFileSync } from 'node:fs';

export function applyRuntimeHotpathIndexes(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0011-runtime-hotpath-indexes.sql', import.meta.url), 'utf8'));
}
