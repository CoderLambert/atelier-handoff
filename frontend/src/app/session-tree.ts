/**
 * @file 聚合会话与从消息派生的分支。
 * @implementation 使用来源 ID 组织项目内的会话，保留搜索命中的祖先，按各组最新活动排序。
 * @updated 2026-11-21T19:45:00+08:00
 */
import type { Project, Session } from '@shared/types';

export interface SessionNode {
  session: Session;
  children: SessionNode[];
  latestActivity: string;
  priorVersion: boolean;
}

export function buildSessionTree(sessions: readonly Session[], query: string): SessionNode[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  function sourceOf(session: Session): Session | undefined {
    const source = session.fork && byId.get(session.fork.sourceSessionId);
    return source && source.id !== session.id && source.projectId === session.projectId
      ? source
      : undefined;
  }
  const latestRewindBySource = new Map<string, Session>();
  for (const session of byId.values()) {
    if (session.fork?.kind !== 'rewind') continue;
    const source = sourceOf(session);
    if (!source) continue;
    const previous = latestRewindBySource.get(source.id);
    if (
      !previous ||
      session.createdAt > previous.createdAt ||
      (session.createdAt === previous.createdAt && session.id > previous.id)
    )
      latestRewindBySource.set(source.id, session);
  }

  function parentOf(session: Session): Session | undefined {
    const replacement = latestRewindBySource.get(session.id);
    if (replacement) return replacement;
    // The newest version takes its predecessor's place. Other branches keep their origin.
    let version = session;
    const seen = new Set([session.id]);
    let source = sourceOf(version);
    while (source && latestRewindBySource.get(source.id)?.id === version.id) {
      if (seen.has(source.id)) return undefined;
      seen.add(source.id);
      version = source;
      source = sourceOf(version);
    }
    return source;
  }

  const rootSessions: Session[] = [];
  const childrenById = new Map<string, Session[]>();
  for (const session of byId.values()) {
    const parent = parentOf(session);
    if (!parent || parent.id === session.id) {
      rootSessions.push(session);
      continue;
    }
    const children = childrenById.get(parent.id);
    if (children) children.push(session);
    else childrenById.set(parent.id, [session]);
  }
  const visited = new Set<string>();
  const filter = query.trim().toLowerCase();
  const recentFirst = (a: SessionNode, b: SessionNode) =>
    b.latestActivity.localeCompare(a.latestActivity) || a.session.id.localeCompare(b.session.id);

  function visit(session: Session): SessionNode | undefined {
    if (visited.has(session.id)) return undefined;
    visited.add(session.id);
    const children = (childrenById.get(session.id) ?? []).flatMap((child) => visit(child) ?? []);
    if (filter && !session.title.toLowerCase().includes(filter) && !children.length) return;
    children.sort(recentFirst);
    const latestChildActivity = children[0]?.latestActivity ?? '';
    return {
      session,
      children,
      priorVersion: latestRewindBySource.has(session.id),
      latestActivity:
        session.updatedAt > latestChildActivity ? session.updatedAt : latestChildActivity,
    };
  }

  const tree = rootSessions.flatMap((session) => visit(session) ?? []);
  // A malformed cycle has no natural root. Keep its sessions reachable once each.
  for (const session of byId.values()) {
    const node = visit(session);
    if (node) tree.push(node);
  }
  return tree.sort(recentFirst);
}

export interface ProjectSessionGroup {
  projectId: string;
  project?: Project;
  nodes: SessionNode[];
  sessionCount: number;
  archivedCount: number;
  latestActivity: string;
}

/** Search a project name to show its full history; session matches keep their source chain. */
export function buildProjectSessionGroups(
  sessions: readonly Session[],
  projects: readonly Project[],
  query: string,
): ProjectSessionGroup[] {
  const byProject = new Map<string, Session[]>();
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  for (const project of projectsById.values()) byProject.set(project.id, []);
  for (const session of sessions) {
    const group = byProject.get(session.projectId);
    if (group) group.push(session);
    else byProject.set(session.projectId, [session]);
  }
  const filter = query.trim().toLowerCase();
  return [...byProject]
    .flatMap(([projectId, entries]) => {
      const project = projectsById.get(projectId);
      const matchesProject = project?.name.toLowerCase().includes(filter);
      const nodes = buildSessionTree(entries, matchesProject ? '' : filter);
      if (filter && !matchesProject && !nodes.length) return [];
      return [
        {
          projectId,
          project,
          nodes,
          sessionCount: entries.length,
          archivedCount: entries.filter((session) => session.status === 'archived').length,
          latestActivity: nodes[0]?.latestActivity ?? project?.createdAt ?? '',
        },
      ];
    })
    .sort(
      (a, b) =>
        b.latestActivity.localeCompare(a.latestActivity) || a.projectId.localeCompare(b.projectId),
    );
}

export interface SessionTreePagination {
  filter: string;
  selected?: string;
  page: number;
}

/** A root and all its descendants always occupy the same page. */
export function paginateSessionTree(
  nodes: SessionNode[],
  selected: string | undefined,
  filter: string,
  pagination?: SessionTreePagination,
  pageSize = 50,
) {
  const selectedPath = findSessionPath(nodes, selected);
  const rootIndex = nodes.findIndex(({ session }) => session.id === selectedPath[0]);
  const lastPage = Math.max(0, Math.ceil(nodes.length / pageSize) - 1);
  const page =
    pagination?.filter === filter && pagination.selected === selected
      ? Math.max(0, Math.min(pagination.page, lastPage))
      : filter
        ? 0
        : Math.max(0, Math.floor(rootIndex / pageSize));
  return {
    page,
    lastPage,
    selectedPath,
    nodes: nodes.slice(page * pageSize, (page + 1) * pageSize),
  };
}

export function findSessionPath(nodes: SessionNode[], id: string | undefined): string[] {
  if (!id) return [];
  for (const { session, children } of nodes) {
    if (session.id === id) return [id];
    const path = findSessionPath(children, id);
    if (path.length) return [session.id, ...path];
  }
  return [];
}
