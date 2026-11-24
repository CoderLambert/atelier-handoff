/**
 * @file 装载 v10 多提交生命周期兼容迁移。
 * @implementation 在 Store 的同一事务内重建旧 v9 表并保留行与 rowid，固定加入两阶段安全放弃状态。
 * @updated 2026-11-24T16:15:46+08:00
 */
import { readFileSync } from 'node:fs';

export function applyGitCommitOperationLifecycle(db: { exec(source: string): unknown }): void {
  db.exec(
    readFileSync(new URL('./0010-git-commit-operation-lifecycle.sql', import.meta.url), 'utf8'),
  );
}
