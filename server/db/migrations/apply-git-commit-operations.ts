/**
 * @file 装载 v9 多提交操作迁移。
 * @implementation 在 Store 的同步事务内执行随包固定 SQL，仅追加新表并保留旧记录。
 * @updated 2026-11-24T14:57:15+08:00
 */
import { readFileSync } from 'node:fs';

export function applyGitCommitOperations(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0009-git-commit-operations.sql', import.meta.url), 'utf8'));
}
