/**
 * @file 展示工作台导航、项目与会话侧栏。
 * @implementation 组合会话与项目菜单、分组会话树和底部导航；管理折叠、分页及原位搜索，并在关闭搜索时清空条件并恢复焦点。
 * @updated 2026-11-26T17:15:12+08:00
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  Bot,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GitBranch,
  History,
  MessagesSquare,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { type Project, type RunStatus, type Session } from '@shared/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/components/ui/utils';
import { useUiTranslation } from '@/i18n';
import { useActiveRuns } from '@/use-query/runs/use-active-runs';
import {
  buildProjectSessionGroups,
  paginateSessionTree,
  type SessionNode,
  type SessionTreePagination,
} from './session-tree';
import { SidebarSessionMenu, type SessionAction } from './sidebar-session-menu';
import { useWorkspace, type View } from './store';
import { formatSessionTime } from '@/utils/format';
import './sidebar.css';

const links = [
  { id: 'artifacts', labelKey: 'links.artifacts', Icon: Package },
  { id: 'runs', labelKey: 'links.runs', Icon: Activity },
  { id: 'extensions', labelKey: 'links.extensions', Icon: Puzzle },
  { id: 'agents', labelKey: 'links.agents', Icon: Bot },
] as const;

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
  const numberFormat = new Intl.NumberFormat(locale);
  const runStatus: Partial<Record<RunStatus | 'idle', string>> = {
    queued: t('status.queued'),
    running: t('status.running'),
    awaiting_permission: t('status.awaitingPermission'),
    stopping: t('status.stopping'),
    idle: t('status.idle'),
    completed: t('status.completed'),
    failed: t('status.failed'),
    interrupted: t('status.interrupted'),
  };
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (collapsed) {
      setSearchOpen(false);
      setSearch('');
    } else if (searchOpen) {
      searchInput.current?.focus();
    }
  }, [collapsed, searchOpen]);
  function closeSearch() {
    setSearch('');
    setSearchOpen(false);
    requestAnimationFrame(() => searchTrigger.current?.focus());
  }
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
  const unseenOutcomes = useWorkspace((state) => state.workspace.unseenRunOutcomes);
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
    const unseen = selected === session.id ? undefined : unseenOutcomes[session.id];
    const status = active?.status ?? unseen ?? 'idle';
    const statusLabel = runStatus[status] ?? t('status.idle');
    const updatedAt = new Date(session.updatedAt);
    const branchLabel = priorVersion
      ? t('session.priorVersion')
      : session.fork && !session.fork.kind
        ? t('session.branch')
        : undefined;
    const BranchIcon = priorVersion ? History : GitBranch;
    const dot =
      archived || status === 'idle' ? null : (
        <span className="sidebar-session-status" title={statusLabel} aria-hidden="true" />
      );
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
          data-status={archived ? undefined : status}
          data-has-children={hasChildren || undefined}
          data-has-status={Boolean(dot) || undefined}
        >
          {hasChildren ? (
            <Button
              size="icon-sm"
              variant="ghost"
              className="history-disclosure"
              aria-expanded={expanded}
              aria-controls={groupId}
              aria-label={t(expanded ? 'session.collapseBranches' : 'session.expandBranches', {
                title: session.title,
              })}
              title={t(expanded ? 'session.collapseBranches' : 'session.expandBranches', {
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
              {dot}
            </Button>
          ) : null}
          <button
            type="button"
            className={cn('history-item', selected === session.id && 'selected')}
            aria-current={selected === session.id ? 'page' : undefined}
            onClick={() => onSession(session.id)}
          >
            {hasChildren ? null : dot}
            <span className="history-title truncate" title={session.title}>
              {session.title}
            </span>
            <span className="history-meta">
              {branchLabel ? (
                <span className="history-meta-icon" title={branchLabel}>
                  <BranchIcon aria-hidden="true" />
                  <span className="sr-only">{branchLabel}</span>
                </span>
              ) : null}
              {archived ? (
                <span className="history-meta-icon" title={t('session.archived')}>
                  <Archive aria-hidden="true" />
                  <span className="sr-only">{t('session.archived')}</span>
                </span>
              ) : (
                <time dateTime={session.updatedAt} title={updatedAt.toLocaleString(locale)}>
                  {formatSessionTime(updatedAt, now, locale)}
                </time>
              )}
            </span>
            {archived ? null : <span className="sr-only">{statusLabel}</span>}
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
      <div className="sidebar-toolbar">
        {searchOpen && !collapsed ? (
          <>
            <label className="sidebar-search">
              <span className="sr-only">{t('sidebar.search')}</span>
              <Search aria-hidden="true" />
              <input
                ref={searchInput}
                className="field w-full"
                type="search"
                placeholder={t('sidebar.searchPlaceholder')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.stopPropagation();
                    closeSearch();
                  }
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              className="sidebar-icon"
              aria-label={t('sidebar.closeSearch')}
              title={t('sidebar.closeSearch')}
              onClick={closeSearch}
            >
              <X aria-hidden="true" />
            </Button>
          </>
        ) : (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size={collapsed ? 'icon-sm' : 'sm'}
                  className="sidebar-home"
                  aria-label={t('sidebar.sessionsAndProjects')}
                  title={t('sidebar.sessionsAndProjects')}
                >
                  {collapsed ? <MessagesSquare aria-hidden="true" /> : t('sidebar.sessions')}
                  {!collapsed ? <ChevronDown data-icon="inline-end" aria-hidden="true" /> : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="sidebar-session-menu"
                side="bottom"
                align="start"
                sideOffset={6}
                collisionPadding={8}
              >
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    className="sidebar-session-menu-item"
                    onSelect={() => onView('chat')}
                  >
                    <MessagesSquare aria-hidden="true" />
                    {t('links.chat')}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="sidebar-session-menu-item" onSelect={onProjects}>
                    <FolderOpen aria-hidden="true" />
                    {t('sidebar.workspaceSettings')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="sidebar-toolbar-actions">
              <Button
                ref={searchTrigger}
                variant="ghost"
                size="icon-sm"
                className="sidebar-icon"
                aria-label={t('sidebar.search')}
                title={t('sidebar.search')}
                disabled={collapsed && !onToggleCollapsed}
                onClick={() => {
                  if (collapsed) onToggleCollapsed?.();
                  setSearchOpen(true);
                }}
              >
                <Search aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="sidebar-icon"
                onClick={onNew}
                aria-label={t('sidebar.newSession')}
                title={t('sidebar.newSession')}
              >
                <Plus aria-hidden="true" />
              </Button>
              {onToggleCollapsed ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="sidebar-icon"
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
          </>
        )}
      </div>
      {!collapsed ? (
        <>
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
              <div className="sidebar-empty">
                <p className="search-empty">
                  {filter ? t('sidebar.noMatches') : t('sidebar.noProjectsOrSessions')}
                </p>
                {!filter ? (
                  <Button variant="outline" size="sm" onClick={onProjects}>
                    <FolderOpen data-icon="inline-start" aria-hidden="true" />
                    {t('sidebar.bindProject')}
                  </Button>
                ) : null}
              </div>
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
      <div className="sidebar-bottom" aria-label={t('sidebar.mainNavigation')}>
        {links.map(({ id, labelKey, Icon }) => (
          <Button
            key={id}
            variant="ghost"
            size="icon-sm"
            className="sidebar-icon"
            aria-label={t(labelKey)}
            aria-current={view === id ? 'page' : undefined}
            title={
              id === 'artifacts' && artifactCount !== undefined
                ? t('sidebar.artifactCount', { count: artifactCount })
                : t(labelKey)
            }
            onClick={() => onView(id)}
          >
            <Icon aria-hidden="true" />
          </Button>
        ))}
        <Button
          variant="ghost"
          size="icon-sm"
          className="sidebar-icon sidebar-settings"
          onClick={onSettings}
          aria-label={t('sidebar.settings')}
          aria-current={view === 'settings' ? 'page' : undefined}
          title={t('sidebar.settings')}
        >
          <Settings aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
