/**
 * @file 实现工作树状态与操作回执仓储。
 * @implementation 在运行时共享连接上保存具名列及会话外键，用领域 schema 验证反序列化。
 * @updated 2026-11-24T03:36:56+08:00
 */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import {
  gitSessionWorktrees,
  gitWorktrees,
  gitWorktreeOperations,
} from '../schema/git-worktrees.js';
import {
  worktreeRecord,
  worktreeOperation,
  type WorktreeRepository,
} from '../../modules/git/worktree-repository.js';

function record(row: typeof gitWorktrees.$inferSelect) {
  return worktreeRecord.parse({ ...row, rebuildable: JSON.parse(row.rebuildable) });
}

export function gitWorktreeRepository(orm: BetterSQLite3Database): WorktreeRepository {
  return {
    byId(id) {
      const row = orm.select().from(gitWorktrees).where(eq(gitWorktrees.id, id)).get();
      return row && record(row);
    },
    byProject(projectId) {
      return orm
        .select()
        .from(gitWorktrees)
        .where(eq(gitWorktrees.projectId, projectId))
        .all()
        .map(record);
    },
    forSession(sessionId) {
      const row = orm
        .select({ worktree: gitWorktrees })
        .from(gitSessionWorktrees)
        .innerJoin(gitWorktrees, eq(gitSessionWorktrees.worktreeId, gitWorktrees.id))
        .where(eq(gitSessionWorktrees.sessionId, sessionId))
        .get();
      return row && record(row.worktree);
    },
    sessions(worktreeId) {
      return orm
        .select({ id: gitSessionWorktrees.sessionId })
        .from(gitSessionWorktrees)
        .where(eq(gitSessionWorktrees.worktreeId, worktreeId))
        .all()
        .map(({ id }) => id);
    },
    bind(sessionId, worktreeId) {
      orm.insert(gitSessionWorktrees).values({ sessionId, worktreeId }).run();
    },
    saveWorktree(value) {
      const row = {
        ...worktreeRecord.parse(value),
        rebuildable: JSON.stringify(value.rebuildable),
      };
      orm
        .insert(gitWorktrees)
        .values(row)
        .onConflictDoUpdate({ target: gitWorktrees.id, set: row })
        .run();
    },
    operation(id) {
      const row = orm
        .select()
        .from(gitWorktreeOperations)
        .where(eq(gitWorktreeOperations.id, id))
        .get();
      return row && worktreeOperation.parse(row);
    },
    pendingOperations() {
      return orm
        .select()
        .from(gitWorktreeOperations)
        .where(eq(gitWorktreeOperations.state, 'pending'))
        .all()
        .map((row) => worktreeOperation.parse(row));
    },
    saveOperation(value) {
      const row = worktreeOperation.parse(value);
      orm
        .insert(gitWorktreeOperations)
        .values(row)
        .onConflictDoUpdate({ target: gitWorktreeOperations.id, set: row })
        .run();
    },
  };
}
