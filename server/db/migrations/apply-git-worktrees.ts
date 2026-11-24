/**
 * @file 装载 v8 Git 工作树迁移。
 * @implementation 在运行时现有事务内执行发行资源中的固定 SQL。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { readFileSync } from 'node:fs';

export function applyGitWorktrees(db: { exec(source: string): unknown }): void {
  db.exec(readFileSync(new URL('./0008-git-worktrees.sql', import.meta.url), 'utf8'));
}
