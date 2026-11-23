/**
 * @file 展示工作台导航、项目与会话侧栏。
 * @implementation 管理搜索、项目及分支展开和分页状态，通过回调触发导航、会话操作及设置。
 * @updated 2026-11-23T05:10:55+08:00
 */
import { useId, useMemo, useState } from 'react';
import {
  Activity,
  Archive,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  MessagesSquare,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Palette,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
import { type Project, type RunStatus, type Session } from '@shared/types';
import { Button } from '@/components/ui/button';
import { ThemePicker } from '@/components/theme-picker';
import { cn } from '@/components/ui/utils';
import { useUiTranslation } from '@/i18n';
import { useUiTheme } from '@/theme';
import { useActiveRuns } from '@/use-query/runs/use-active-runs';
import {
  buildProjectSessionGroups,
  paginateSessionTree,
  type SessionNode,
  type SessionTreePagination,
} from './session-tree';
import { SidebarSessionMenu, type SessionAction } from './sidebar-session-menu';
import { type View } from './store';
import './sidebar.css';

const links = [
  { id: 'chat', labelKey: 'links.chat', Icon: MessagesSquare },
  { id: 'artifacts', labelKey: 'links.artifacts', Icon: Package },
  { id: 'runs', labelKey: 'links.runs', Icon: Activity },
  { id: 'extensions', labelKey: 'links.extensions', Icon: Boxes },
  { id: 'agents', labelKey: 'links.agents', Icon: Bot },
] as const;

function formatSessionTime(updatedAt: Date, now: Date, locale: string): string {
  if (updatedAt.getFullYear() !== now.getFullYear()) {
    return updatedAt.toLocaleDateString(locale, { dateStyle: 'short' });
  }
  if (updatedAt.getMonth() === now.getMonth() && updatedAt.getDate() === now.getDate()) {
    return updatedAt.toLocaleTimeString(locale, { timeStyle: 'short' });
  }
  return updatedAt.toLocaleDateString(locale, { month: 'numeric', day: 'numeric' });
}

export function Sidebar({
  project,
  current,
  view,
  projects,
  artifactCount,
  sessions,
  sessionsFailed,
  onRetrySessions,
  onSession,
  onSessionAction,
  onView,
  onNew,
  onNewProject,
  onProjects,
  onSettings,
  collapsed = false,
  onToggleCollapsed,
}: {
  project?: Project;
  current?: string;
  view: View;
  projects?: readonly Project[];
  artifactCount?: number;
  sessions?: readonly Session[];
  sessionsFailed: boolean;
  onRetrySessions: () => void;
  onSession: (id: string) => void;
  onSessionAction?: (type: SessionAction, session: Session) => void;
  onView: (view: View) => void;
  onNew: () => void;
  onNewProject?: (id: string) => void;
  onProjects: () => void;
  onSettings: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t, locale } = useUiTranslation('navigation');
  const { theme } = useUiTheme();
  const themeLabels: Record<string, string> = {
    obsidian: t('sidebar.themeObsidian'),
    classic: t('sidebar.themeClassic'),
    parchment: t('sidebar.themeParchment'),
    nordic: t('sidebar.themeNordic'),
    rose: t('sidebar.themeRose'),
    midnight: t('sidebar.themeMidnight'),
  };
  const activeThemeLabel = themeLabels[theme] ?? t('sidebar.themeObsidian');
  const numberFormat = new Intl.NumberFormat(locale);
  const runStatus: Partial<Record<RunStatus, string>> = {
    queued: t('status.queued'),
    running: t('status.running'),
    awaiting_permission: t('status.awaitingPermission'),
    stopping: t('status.stopping'),
  };
  const [search, setSearch] = useState('');
  const [pagination, setPagination] = useState(() => new Map<string, SessionTreePagination>());
  const [closedBranches, setClosedBranches] = useState(() => new Map<string, string | undefined>());
  const [closedProjects, setClosedProjects] = useState(() => new Map<string, string | undefined>());
  const [menuBoundary, setMenuBoundary] = useState<HTMLElement | null>(null);
  const treeId = useId();
  const filter = search.trim();
  const groups = useMemo(() => {
    const knownProjects = new Map(projects?.map((entry) => [entry.id, entry]));
    if (project && !knownProjects.has(project.id)) knownProjects.set(project.id, project);
    return buildProjectSessionGroups(sessions ?? [], [...knownProjects.values()], filter);
  }, [sessions, projects, project, filter]);
  const selected = view === 'chat' ? current : undefined;
  const activity = useActiveRuns();
  const bySession = new Map(
    activity.flatMap((query) => query.data?.items ?? []).map((run) => [run.sessionId, run]),
  );

  const now = new Date();

  function renderSession(
    { session, children, priorVersion }: SessionNode,
    selectedPath: string[],
    depth = 0,
  ) {
    const active = bySession.get(session.id);
    const archived = session.status === 'archived';
    const status = active ? runStatus[active.status] : undefined;
    const updatedAt = new Date(session.updatedAt);
    const meta = [
      priorVersion
        ? t('session.priorVersion')
        : session.fork && !session.fork.kind
          ? t('session.branch')
          : undefined,
      archived ? t('session.archived') : undefined,
      archived ? undefined : formatSessionTime(updatedAt, now, locale),
    ]
      .filter(Boolean)
      .join(' · ');
    const hasChildren = children.length > 0;
    const revealSelected =
      selectedPath.includes(session.id) && closedBranches.get(session.id) !== selected;
    const expanded =
      hasChildren && (Boolean(filter) || revealSelected || !closedBranches.has(session.id));
    const groupId = `${treeId}-branches-${session.id}`;
    const Chevron = expanded ? ChevronDown : ChevronRight;
    return (
      <li key={session.id} data-session-node={session.id}>
        <div
          className="history-node-row sidebar-session-row"
          data-selected={selected === session.id || undefined}
        >
          {hasChildren ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="history-disclosure"
              data-status={active?.status}
              aria-expanded={expanded}
              aria-controls={groupId}
              aria-label={t(expanded ? 'session.collapseBranches' : 'session.expandBranches', {
                title: session.title,
              })}
              disabled={Boolean(filter)}
              onClick={() =>
                setClosedBranches((previous) => {
                  const next = new Map(previous);
                  if (expanded) next.set(session.id, selected);
                  else next.delete(session.id);
                  return next;
                })
              }
            >
              <Chevron data-icon="inline-start" aria-hidden="true" />
              {active ? (
                <span
                  className="sidebar-status-ring sidebar-status-ring--disclosure"
                  aria-hidden="true"
                />
              ) : null}
            </Button>
          ) : (
            <span
              className={cn('sidebar-disclosure-space', active && 'has-status')}
              data-status={active?.status}
              title={status}
              onClick={active ? () => onSession(session.id) : undefined}
            >
              {active ? (
                <span className="sidebar-status-ring" aria-hidden="true" />
              ) : null}
            </span>
          )}
          <button
            type="button"
            className={cn('history-item', selected === session.id && 'selected')}
            aria-current={selected === session.id ? 'page' : undefined}
            onClick={() => onSession(session.id)}
          >
            <span className="history-title truncate" title={session.title}>
              {session.title}
            </span>
            <span
              className="history-meta"
              data-status={active?.status}
              title={updatedAt.toLocaleString(locale)}
            >
              {archived ? <Archive aria-hidden="true" /> : null}
              {active && status ? <span className="sr-only">{status}</span> : null}
              <span className="truncate">{meta}</span>
            </span>
          </button>
          {onSessionAction ? (
            <SidebarSessionMenu
              session={session}
              onAction={onSessionAction}
              boundary={menuBoundary}
            />
          ) : null}
        </div>
        {hasChildren ? (
          <ul
            id={groupId}
            className="history-tree history-branches"
            data-indent={depth < 3 || undefined}
            hidden={!expanded}
          >
            {expanded
              ? children.map((child) => renderSession(child, selectedPath, depth + 1))
              : null}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <nav
      ref={setMenuBoundary}
      className={cn('sidebar atelier-sidebar', collapsed && 'sidebar-collapsed')}
      aria-label={t('sidebar.navigation')}
      data-collapsed={collapsed}
    >
      <div className="sidebar-brand-row">
        {!collapsed ? (
          <div className="wordmark">
            <span className="brand-symbol" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>
              {t('brand.name')}
              <span className="brand-period">.</span>
            </span>
          </div>
        ) : null}
        {onToggleCollapsed ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" />
            ) : (
              <PanelLeftClose aria-hidden="true" />
            )}
          </Button>
        ) : null}
      </div>
      <button
        type="button"
        className="workspace-switch"
        onClick={onProjects}
        aria-label={t('sidebar.openWorkspaceSettings')}
        title={collapsed ? t('sidebar.workspaceSettings') : project?.path}
      >
        <span className="workspace-avatar">
          <FolderOpen aria-hidden="true" />
        </span>
        {!collapsed ? (
          <span className="sidebar-workspace-name">
            <span className="overline">{t('sidebar.workingDirectory')}</span>
            <strong>{project?.name ?? t('sidebar.bindProject')}</strong>
          </span>
        ) : null}
      </button>
      <Button
        size={collapsed ? 'icon' : 'default'}
        variant="outline"
        className="new-session"
        onClick={onNew}
        aria-label={t('sidebar.newSession')}
        title={collapsed ? t('sidebar.newSession') : undefined}
      >
        <Plus data-icon="inline-start" aria-hidden="true" />
        {!collapsed ? t('sidebar.newSession') : null}
      </Button>
      {!collapsed ? (
        <label className="sidebar-search">
          <span className="sr-only">{t('sidebar.search')}</span>
          <Search aria-hidden="true" />
          <input
            className="field w-full"
            type="search"
            placeholder={t('sidebar.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      ) : null}
      <div className="main-nav" aria-label={t('sidebar.mainNavigation')}>
        {links.map(({ id, labelKey, Icon }) => (
          <Button
            key={id}
            size={collapsed ? 'icon' : 'sm'}
            variant="ghost"
            className="nav-item"
            aria-label={t(labelKey)}
            aria-current={view === id ? 'page' : undefined}
            title={collapsed ? t(labelKey) : undefined}
            onClick={() => onView(id)}
          >
            <Icon data-icon="inline-start" aria-hidden="true" />
            {!collapsed ? (
              <>
                <span>{t(labelKey)}</span>
                {id === 'chat' ? (
                  <span className="ml-auto">{numberFormat.format(sessions?.length ?? 0)}</span>
                ) : null}
                {id === 'artifacts' && artifactCount !== undefined ? (
                  <span className="ml-auto">{numberFormat.format(artifactCount)}</span>
                ) : null}
              </>
            ) : null}
          </Button>
        ))}
      </div>
      {!collapsed ? (
        <>
          <div className="sidebar-section-label">{t('sidebar.projectSessions')}</div>
          <div className="history-wrap min-h-0 flex-1 overflow-auto">
            {sessionsFailed ? (
              <Button variant="ghost" onClick={onRetrySessions}>
                {t('sidebar.sessionsFailed')}
              </Button>
            ) : null}
            {!sessions && !sessionsFailed ? (
              <p className="search-empty" role="status">
                {t('sidebar.sessionsLoading')}
              </p>
            ) : null}
            {sessions && !groups.length ? (
              <p className="search-empty">
                {filter ? t('sidebar.noMatches') : t('sidebar.noProjectsOrSessions')}
              </p>
            ) : null}
            {groups.map((group) => {
              const page = paginateSessionTree(
                group.nodes,
                selected,
                filter,
                pagination.get(group.projectId),
              );
              const revealSelected =
                page.selectedPath.length > 0 && closedProjects.get(group.projectId) !== selected;
              const expanded =
                Boolean(filter) || revealSelected || !closedProjects.has(group.projectId);
              const projectTitle =
                group.project?.name ?? t('sidebar.unavailableProject', { id: group.projectId });
              const groupId = `${treeId}-project-${group.projectId}`;
              const Chevron = expanded ? ChevronDown : ChevronRight;
              const canCreate =
                group.project?.available && (onNewProject || project?.id === group.projectId);
              const setPage = (next: number) =>
                setPagination((previous) =>
                  new Map(previous).set(group.projectId, { filter, selected, page: next }),
                );
              return (
                <section
                  className="sidebar-project"
                  key={group.projectId}
                  data-project-id={group.projectId}
                  aria-label={projectTitle}
                >
                  <div className="sidebar-project-heading">
                    <button
                      type="button"
                      className="sidebar-project-toggle"
                      aria-expanded={expanded}
                      aria-controls={groupId}
                      title={group.project?.path ?? projectTitle}
                      onClick={() =>
                        setClosedProjects((previous) => {
                          const next = new Map(previous);
                          if (expanded) next.set(group.projectId, selected);
                          else next.delete(group.projectId);
                          return next;
                        })
                      }
                      disabled={Boolean(filter)}
                    >
                      <Chevron aria-hidden="true" />
                      <FolderOpen aria-hidden="true" />
                      <span className="truncate">{projectTitle}</span>
                      <span className="sidebar-project-count">
                        {numberFormat.format(group.sessionCount)}
                      </span>
                    </button>
                    {canCreate ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="sidebar-project-new"
                        aria-label={t('sidebar.newProjectSession', { title: projectTitle })}
                        title={t('sidebar.newProjectSession', { title: projectTitle })}
                        onClick={() => (onNewProject ? onNewProject(group.projectId) : onNew())}
                      >
                        <Plus aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                  <div id={groupId} hidden={!expanded}>
                    {group.archivedCount > 0 ? (
                      <p className="sidebar-archive-summary">
                        {t('sidebar.archivedSessions', {
                          count: group.archivedCount,
                          countText: numberFormat.format(group.archivedCount),
                        })}
                      </p>
                    ) : null}
                    {group.project && !group.project.available ? (
                      <p className="sidebar-project-empty">{t('sidebar.projectUnavailable')}</p>
                    ) : null}
                    {!group.nodes.length && sessions ? (
                      <p className="sidebar-project-empty">{t('sidebar.noSessions')}</p>
                    ) : null}
                    {group.nodes.length > 0 ? (
                      <ul
                        className="history-tree"
                        aria-label={t('sidebar.sessionTree', { title: projectTitle })}
                      >
                        {page.nodes.map((node) => renderSession(node, page.selectedPath))}
                      </ul>
                    ) : null}
                    {page.lastPage > 0 ? (
                      <div
                        className="sidebar-pagination"
                        aria-label={t('sidebar.sessionPagination', { title: projectTitle })}
                      >
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={page.page === 0}
                          onClick={() => setPage(page.page - 1)}
                        >
                          {t('sidebar.previousPage')}
                        </Button>
                        <span>
                          {t('sidebar.page', {
                            page: numberFormat.format(page.page + 1),
                            total: numberFormat.format(page.lastPage + 1),
                          })}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={page.page === page.lastPage}
                          onClick={() => setPage(page.page + 1)}
                        >
                          {t('sidebar.nextPage')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      ) : null}
      <div className="sidebar-bottom">
        <ThemePicker align="start" side="right">
          <Button
            variant="ghost"
            size={collapsed ? 'icon-sm' : 'default'}
            aria-label={t('sidebar.themeToggle')}
            title={t('sidebar.themeCurrent', { theme: activeThemeLabel })}
          >
            <Palette data-icon="inline-start" aria-hidden="true" />
            {!collapsed ? activeThemeLabel : null}
          </Button>
        </ThemePicker>
        <Button
          variant="ghost"
          size={collapsed ? 'icon-sm' : 'default'}
          onClick={onSettings}
          aria-label={t('sidebar.settings')}
          aria-current={view === 'settings' ? 'page' : undefined}
          title={collapsed ? t('sidebar.settings') : undefined}
        >
          <Settings2 data-icon="inline-start" aria-hidden="true" />
          {!collapsed ? t('sidebar.settings') : null}
        </Button>
      </div>
    </nav>
  );
}
