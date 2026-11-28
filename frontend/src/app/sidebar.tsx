/**
 * @file 展示工作台导航、项目与会话侧栏。
 * @implementation 记忆化格式化器、运行状态映射与交互回调，组合 SidebarSearchBar 与 SidebarProjectGroup 分层渲染项目及会话树。
 * @updated 2026-11-27T22:25:00+08:00
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  ChevronDown,
  Clock,
  FolderOpen,
  MessagesSquare,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  Search,
  Settings,
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
import { sessionSwitchItems } from './session-switcher-model';
import { buildProjectSessionGroups, type SessionTreePagination } from './session-tree';
import { CollapsedSessionMenuItems } from './sidebar-collapsed-sessions';
import type { SessionAction } from './sidebar-session-menu';
import { SidebarProjectGroup } from './sidebar-project-group';
import { SidebarSearchBar } from './sidebar-search-bar';
import { useWorkspace, type View } from './store';
import './sidebar.css';

const links = [
  { id: 'artifacts', labelKey: 'links.artifacts', Icon: Package },
  { id: 'runs', labelKey: 'links.runs', Icon: Activity },
  { id: 'extensions', labelKey: 'links.extensions', Icon: Puzzle },
  { id: 'agents', labelKey: 'links.agents', Icon: Bot },
  { id: 'schedules', labelKey: 'links.schedules', Icon: Clock },
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
  onOpenSwitcher,
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
  onOpenSwitcher?: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { t, locale } = useUiTranslation('navigation');
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const runStatus = useMemo<Partial<Record<RunStatus | 'idle', string>>>(
    () => ({
      queued: t('status.queued'),
      running: t('status.running'),
      awaiting_permission: t('status.awaitingPermission'),
      stopping: t('status.stopping'),
      idle: t('status.idle'),
      completed: t('status.completed'),
      failed: t('status.failed'),
      interrupted: t('status.interrupted'),
    }),
    [t],
  );
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
  const closeSearch = useCallback(() => {
    setSearch('');
    setSearchOpen(false);
    requestAnimationFrame(() => searchTrigger.current?.focus());
  }, []);
  const [pagination, setPagination] = useState(() => new Map<string, SessionTreePagination>());
  const [closedBranches, setClosedBranches] = useState(() => new Map<string, string | undefined>());
  const [closedProjects, setClosedProjects] = useState(() => new Map<string, string | undefined>());
  const [menuBoundary, setMenuBoundary] = useState<HTMLElement | null>(null);
  const treeId = useId();
  const filter = search.trim();
  const knownProjects = useMemo(() => {
    const map = new Map(projects?.map((entry) => [entry.id, entry]));
    if (project && !map.has(project.id)) map.set(project.id, project);
    return [...map.values()];
  }, [projects, project]);

  const groups = useMemo(
    () => buildProjectSessionGroups(sessions ?? [], knownProjects, filter),
    [sessions, knownProjects, filter],
  );

  const selected = view === 'chat' ? current : undefined;
  const unseenOutcomes = useWorkspace((state) => state.workspace.unseenRunOutcomes);
  const activity = useActiveRuns();
  const bySession = useMemo(
    () =>
      new Map(
        activity.flatMap((query) => query.data?.items ?? []).map((run) => [run.sessionId, run]),
      ),
    [activity],
  );
  const now = useMemo(() => new Date(), [sessions, activity]);

  const recentSessions = useMemo(
    () =>
      collapsed
        ? sessionSwitchItems(sessions ?? [], knownProjects, '').filter(
            (item) => item.session.status !== 'archived',
          )
        : [],
    [collapsed, sessions, knownProjects],
  );

  const collapsedSessionProps = {
    recentSessions,
    selected,
    bySession,
    unseenOutcomes,
    runStatus,
    onSession,
  };

  const handleToggleBranch = useCallback(
    (sessionId: string, expanded: boolean) => {
      setClosedBranches((previous) => {
        const next = new Map(previous);
        if (expanded) next.set(sessionId, selected);
        else next.delete(sessionId);
        return next;
      });
    },
    [selected],
  );

  const handleToggleProject = useCallback(
    (projectId: string, expanded: boolean) => {
      setClosedProjects((previous) => {
        const next = new Map(previous);
        if (expanded) next.set(projectId, selected);
        else next.delete(projectId);
        return next;
      });
    },
    [selected],
  );

  const handlePageChange = useCallback(
    (projectId: string, nextPage: number) => {
      setPagination((previous) =>
        new Map(previous).set(projectId, { filter, selected, page: nextPage }),
      );
    },
    [filter, selected],
  );

  return (
    <nav
      ref={setMenuBoundary}
      className={cn('sidebar atelier-sidebar', collapsed && 'sidebar-collapsed')}
      aria-label={t('sidebar.navigation')}
      data-collapsed={collapsed}
    >
      <div className="sidebar-toolbar">
        {searchOpen && !collapsed ? (
          <SidebarSearchBar
            inputRef={searchInput}
            value={search}
            onChange={setSearch}
            onClose={closeSearch}
          />
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
                className={cn('sidebar-session-menu', collapsed && 'sidebar-session-menu-wide')}
                side={collapsed ? 'right' : 'bottom'}
                align="start"
                sideOffset={collapsed ? 10 : 6}
                collisionPadding={12}
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
                {collapsed ? (
                  <CollapsedSessionMenuItems
                    {...collapsedSessionProps}
                    onOpenSwitcher={onOpenSwitcher}
                  />
                ) : null}
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
                disabled={collapsed && !onOpenSwitcher && !onToggleCollapsed}
                onClick={() => {
                  if (collapsed && onOpenSwitcher) {
                    onOpenSwitcher();
                    return;
                  }
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
          {groups.map((group) => (
            <SidebarProjectGroup
              key={group.projectId}
              group={group}
              selected={selected}
              filter={filter}
              treeId={treeId}
              activeProjectId={project?.id}
              sessionsLoaded={Boolean(sessions)}
              pagination={pagination.get(group.projectId)}
              closedSelection={closedProjects.get(group.projectId)}
              hasClosedEntry={closedProjects.has(group.projectId)}
              numberFormat={numberFormat}
              bySession={bySession}
              unseenOutcomes={unseenOutcomes}
              closedBranches={closedBranches}
              runStatus={runStatus}
              menuBoundary={menuBoundary}
              now={now}
              onSession={onSession}
              onSessionAction={onSessionAction}
              onNew={onNew}
              onNewProject={onNewProject}
              onToggleProject={handleToggleProject}
              onToggleBranch={handleToggleBranch}
              onPageChange={handlePageChange}
            />
          ))}
        </div>
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
