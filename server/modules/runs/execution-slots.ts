/**
 * @file 判定活动运行和目录占用。
 * @implementation 按会话、重叠目录和全局运行数检查执行槽，为工作树保留原运行、审批、队列与分支保护。
 * @updated 2026-11-27T20:10:00+08:00
 */
import { AppError, type Session } from '../../../shared/types.js';
import type { Store } from '../../store.js';
import { directoriesOverlap } from '../git/development-worktrees.js';

export function createExecutionSlots({
  store,
  directory,
  assertUnlocked,
  hasPending,
  usingForkSource,
}: {
  store: Pick<Store, 'list' | 'get' | 'repos'>;
  directory(session: Session): string;
  assertUnlocked(path: string): void;
  hasPending(sessionId: string): boolean;
  usingForkSource(sessionId: string): boolean;
}) {
  const sameSessionRunning = (id: string) => store.repos.runs.hasActiveBySession(id);

  function assertExecutionSlot(sessionId: string, path: string) {
    assertUnlocked(path);
    const active = store.repos.runs.listActive();
    if (
      active.some((run) => {
        const other = run.workspacePath ?? store.get('projects', run.projectId).path;
        return run.sessionId === sessionId || (path !== other && directoriesOverlap(path, other));
      })
    )
      throw new AppError(
        'RUN_ACTIVE',
        '该项目或重叠目录已有活动运行，请先处理审批或停止后再发送。',
        409,
      );
    if (active.length >= 3)
      throw new AppError('SERVER_BUSY', '同时最多执行 3 个会话，请稍后发送。', 409, true);
  }

  function directoryInUse(path: string) {
    const sessions = new Set(
      store
        .list('sessions')
        .filter((session) => directoriesOverlap(path, directory(session)))
        .map((session) => session.id),
    );
    return (
      store.repos.runs
        .listActive()
        .some((run) =>
          directoriesOverlap(path, run.workspacePath ?? store.get('projects', run.projectId).path),
        ) ||
      store.repos.permissions
        .listPending()
        .some((permission) => sessions.has(permission.sessionId)) ||
      [...sessions].some((id) => hasPending(id) || usingForkSource(id))
    );
  }

  return { assertExecutionSlot, sameSessionRunning, directoryInUse };
}
