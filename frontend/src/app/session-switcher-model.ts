/**
 * @file 提供会话快捷切换的筛选与相邻导航规则。
 * @implementation 以最近更新和 ID 稳定排序，搜索标题与项目，归档可检索但不参与连续切换。
 * @updated 2026-11-26T20:00:00+08:00
 */
import type { Project, Session } from '../../../shared/types.js';

export interface SessionSwitchItem {
  session: Session;
  projectName: string;
}

function recentFirst(a: Session, b: Session) {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function sessionSwitchItems(
  sessions: readonly Session[],
  projects: readonly Project[],
  query: string,
): SessionSwitchItem[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const filter = query.trim().toLocaleLowerCase();
  return sessions
    .filter((session) => !session.creatingFork)
    .map((session) => ({ session, projectName: names.get(session.projectId) ?? '' }))
    .filter(({ session, projectName }) =>
      `${session.title}\n${projectName}`.toLocaleLowerCase().includes(filter),
    )
    .sort(
      (a, b) =>
        Number(a.session.status === 'archived') - Number(b.session.status === 'archived') ||
        recentFirst(a.session, b.session),
    );
}

export function adjacentSessionId(
  sessions: readonly Session[],
  current: string | undefined,
  direction: 1 | -1,
): string | undefined {
  const active = sessions
    .filter((session) => session.status === 'active' && !session.creatingFork)
    .sort(recentFirst);
  if (!active.length || (active.length === 1 && active[0]?.id === current)) return undefined;
  const index = active.findIndex(({ id }) => id === current);
  return active[index < 0 ? 0 : (index + direction + active.length) % active.length]?.id;
}
