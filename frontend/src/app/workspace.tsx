/**
 * @file 编排工作区、会话及功能面板。
 * @implementation 协调路由、工具栏中的会话标签与键盘切换，以及 Git、浏览器和终端面板的展示、尺寸与焦点，并将所选代码加入同项目会话草稿。
 * @updated 2026-11-26T17:15:12+08:00
 */
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, FileDiff, FileText, FolderOpen, MessagesSquare, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { WorkspaceToolbar } from './workspace-toolbar';
import { WorkspaceNotice } from './workspace-notice';
import {
  useCanGoBack,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { isWorkspaceLocation, workspaceSessionId } from '@shared/workspace-location';
import { useRememberWorkspaceLocation } from '@/use-query/settings/use-remember-workspace-location';
import type { Project, Run, Session } from '@shared/types';
import { initialWorkspaceLayout, type WorkspaceLayout } from '@shared/workspace-layout';
import { useWorkspaceLayout } from '@/use-query/settings/use-workspace-layout';
import { useUpdateWorkspaceLayout } from '@/use-query/settings/use-update-workspace-layout';
import { useCreateSession } from '@/use-query/sessions/use-create-session';
import { useUpdateSession } from '@/use-query/sessions/use-update-session';
import { useDeleteSession } from '@/use-query/sessions/use-delete-session';
import { updateSessionDraft } from '@/use-query/sessions/use-update-session-draft';
import { WorkspacePanels, useWorkspaceViewport } from './workspace-panels';
import { bootstrap } from '@/api/client';
import {
  sessionSnapshotOptions,
  useSessionSnapshot,
} from '@/use-query/sessions/use-session-snapshot';
import { gitKeys } from '@/use-query/git/keys';
import { SessionWorktree } from '@/features/git/session-worktree';
import type { QuoteGitCode } from '@/features/git/git-code-selection';
import { Button } from '@/components/ui/button';
import { translateError, useUiTranslation } from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { appendFileQuote, deleteDraft, lastSession, rememberSession } from './drafts';
import { keys, useRunEvents } from './events';
import { ProjectsDialog } from './projects';
import { Sidebar } from './sidebar';
import { useBrowserPreview } from '@/use-query/browser/use-browser-preview';
import { useForkSession } from '@/use-query/sessions/use-fork-session';
import { useUpgradeSessionAgent } from '@/use-query/sessions/use-upgrade-session-agent';
import { useStopRun } from '@/use-query/runs/use-stop-run';
import { useRetryRun } from '@/use-query/runs/use-retry-run';
import { useDesktopBrowser } from './desktop-browser';
import { PanelHost } from './panels/panel-host';
import { panels } from './panels/registry';
import { panelLocation } from './panels/panel-location';
import { useWorkspacePanel } from './panels/use-workspace-panel';
import { actions, type Tab, useAppDispatch, useWorkspace, type View } from './store';
import type { SessionAction, SettingsSection } from './types';

const SessionChat = lazy(() => import('./session-chat'));
const ExtensionsPage = lazy(() => import('@/features/extensions'));
const AgentsPage = lazy(() => import('@/features/agents'));

const SessionChanges = lazy(() =>
  import('@/features/inspector').then(({ SessionChanges }) => ({ default: SessionChanges })),
);
const RunTrace = lazy(() =>
  import('@/features/inspector').then(({ RunTrace }) => ({ default: RunTrace })),
);
const Collections = lazy(() =>
  import('@/features/inspector').then(({ Collections }) => ({ default: Collections })),
);
const Settings = lazy(() => import('@/features/inspector/settings-page'));
const sectionNames = {
  runs: 'section.runs',
  artifacts: 'section.artifacts',
  extensions: 'section.extensions',
  agents: 'section.agents',
  settings: 'section.settings',
} as const;
const collectionPaths = {
  runs: '/runs',
  artifacts: '/artifacts',
  extensions: '/extensions',
  agents: '/agents',
} as const;
const settingsPaths = {
  models: '/settings/models',
  layout: '/settings/layout',
  notifications: '/settings/notifications',
  diagnostics: '/settings/diagnostics',
} as const;

function currentView(pathname: string): View {
  if (pathname.startsWith('/settings/')) return 'settings';
  return (
    (Object.keys(collectionPaths) as (keyof typeof collectionPaths)[]).find(
      (view) => collectionPaths[view] === pathname,
    ) ?? 'chat'
  );
}
const tabs = [
  { id: 'conversation', labelKey: 'tab.conversation', Icon: MessagesSquare },
  { id: 'trace', labelKey: 'tab.trace', Icon: Activity },
  { id: 'artifacts', labelKey: 'section.artifacts', Icon: FileText },
] as const;
const active = new Set(['queued', 'running', 'awaiting_permission', 'stopping']);

const sessionActions = {
  rename: 'session.rename',
  archive: 'session.archive',
  restore: 'session.restore',
  delete: 'session.delete',
} as const;

export default function Workspace() {
  const { t, locale } = useUiTranslation('workbench');
  const { t: git } = useUiTranslation('git');
  const { t: terminal } = useUiTranslation('terminal');
  const sessionContentId = useId();
  const numberFormat = new Intl.NumberFormat(locale);
  const loading = (
    <p className="empty-text px-5 py-4" role="status">
      {t('loading')}
    </p>
  );
  const dispatch = useAppDispatch();
  const client = useQueryClient();
  const location = useLocation();
  const pathname = location.pathname;
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { sessionId, runId: routeRunId, messageId: routeMessageId } = useParams({ strict: false });
  const { routePanel, contentPath } = panelLocation(pathname, sessionId, location.state);
  const trace = routePanel ? contentPath.match(/\/trace\/([^/]+)$/u)?.[1] : routeRunId;
  const messageId = routePanel ? contentPath.match(/\/messages\/([^/]+)$/u)?.[1] : routeMessageId;
  const view = currentView(pathname);
  const tab: Tab = contentPath.includes('/trace')
    ? 'trace'
    : sessionId && contentPath.endsWith('/artifacts')
      ? 'artifacts'
      : 'conversation';
  const section: SettingsSection =
    pathname === settingsPaths.layout
      ? 'layout'
      : pathname === settingsPaths.notifications
        ? 'notifications'
        : pathname === settingsPaths.diagnostics
          ? 'diagnostics'
          : 'models';
  const drawer = useWorkspace((state) => state.workspace.drawer);
  const connected = useWorkspace((state) => state.workspace.connected);
  const ready = useQuery({ queryKey: keys.bootstrap, queryFn: bootstrap, staleTime: 30_000 });
  const session = useSessionSnapshot(sessionId);
  const snapshot = session.data;
  const selectedRun =
    snapshot?.runs.find((run) => run.id === trace) ??
    snapshot?.runs.find((run) => active.has(run.status)) ??
    snapshot?.runs.at(-1);
  const project =
    snapshot?.project ??
    ready.data?.projects.find(
      (item) => item.id === ready.data?.sessions.find((item) => item.id === sessionId)?.projectId,
    ) ??
    ready.data?.projects[0];
  const previewProject = view === 'chat' ? project?.id : undefined;
  const desktop = Boolean(window.atelierDesktop);
  const nativeBrowser = useDesktopBrowser(desktop ? previewProject : undefined);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const width = useWorkspaceViewport();
  const panel = useWorkspacePanel({ sessionId, snapshot, width });
  const {
    gitBoard,
    gitBusy,
    gitWidth,
    setGitWidth,
    gitFullWindow,
    canDockGit,
    gitTrigger,
    expandGit,
    openGit,
    closeGit,
    browserActive,
    browserTrigger,
    openBrowser,
    closeBrowser,
  } = panel;
  const browser = useBrowserPreview(desktop || !browserActive ? undefined : previewProject, true);
  const layoutQuery = useWorkspaceLayout();
  const updateLayout = useUpdateWorkspaceLayout();
  const [localLayout, setLocalLayout] = useState<WorkspaceLayout>();
  const layout = localLayout ?? layoutQuery.data ?? initialWorkspaceLayout;
  const showLeft = width >= 768;
  const canQuoteGit =
    view === 'chat' &&
    snapshot &&
    snapshot.session.id === sessionId &&
    snapshot.session.status !== 'archived' &&
    snapshot.project.id === gitBoard?.project.id;
  const quoteGitCode: QuoteGitCode = (file, text) => {
    if (!canQuoteGit || !snapshot) return 'unavailable';
    const result = appendFileQuote(snapshot.session.id, snapshot.session.draft, file, text);
    if (result === 'added' || result === 'duplicate') {
      if (tab !== 'conversation') selectTab('conversation');
      if (canDockGit && gitFullWindow) expandGit(false);
      if (canDockGit && tab === 'conversation')
        requestAnimationFrame(() => {
          if (router.state.location.pathname === pathname)
            document.getElementById('prompt-input')?.focus({ preventScroll: true });
        });
    }
    return result;
  };
  const showBrowserRight =
    view === 'chat' && browserActive && (width > 1120 || (width >= 900 && desktop));
  const drawerTrigger = useRef<HTMLElement | null>(null);
  function openDrawer(next: 'navigation' | 'details') {
    drawerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dispatch(actions.setDrawer(next));
  }
  function changeLayout(next: WorkspaceLayout) {
    setLocalLayout(next);
    updateLayout.mutate(next, {
      onError: (error) => setNotice(translateError(error, t('layout.saveFailed'))),
    });
  }
  const [sessionChange, setSessionChange] = useState<{ type: SessionAction; session: Session }>();
  const [title, setTitle] = useState('');
  const sessionActionTrigger = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState('');
  const forkSession = useForkSession();
  const forkKeys = useRef(new Map<string, string>());
  const forking = useRef(false);
  const savedLocation = useRef<string | undefined>(undefined);
  const rememberLocation = useRememberWorkspaceLocation();
  const retryKeys = useRef(new Map<string, string>());
  useRunEvents(client, ready.data?.cursor, view === 'chat' ? sessionId : undefined);

  useEffect(() => {
    function onRunFinished(event: Event) {
      const custom = event as CustomEvent<{ sessionId?: string; status?: string }>;
      const finishedSessionId = custom.detail?.sessionId;
      if (finishedSessionId && (!sessionId || sessionId === finishedSessionId)) {
        if (!sessionId) {
          void navigate({ to: `/sessions/${encodeURIComponent(finishedSessionId)}` });
        }
      }
    }
    window.addEventListener('atelier:run-finished', onRunFinished);
    return () => {
      window.removeEventListener('atelier:run-finished', onRunFinished);
    };
  }, [sessionId, navigate]);

  useEffect(() => {
    if (!ready.data || pathname !== '/') return;
    const saved = ready.data.workspaceLocation;
    const savedId = saved ? workspaceSessionId(saved) : undefined;
    if (
      saved &&
      isWorkspaceLocation(saved) &&
      (!savedId || ready.data.sessions.some(({ id }) => id === savedId))
    ) {
      router.history.replace(saved);
    } else {
      const previous = ready.data.workspaceLastSession ?? lastSession();
      const restored =
        ready.data.sessions.find(({ id }) => id === previous) ??
        ready.data.sessions.find(({ status }) => status === 'active') ??
        ready.data.sessions[0];
      if (restored)
        void navigate({
          to: '/sessions/$sessionId',
          params: { sessionId: restored.id },
          replace: true,
        });
      else void navigate({ to: '/sessions', replace: true });
      if (!ready.data.projects.length) setProjectsOpen(true);
    }
  }, [navigate, pathname, ready.data, router.history]);

  useEffect(() => {
    if (!ready.data || pathname === savedLocation.current || !isWorkspaceLocation(pathname)) return;
    if (sessionId && !ready.data.sessions.some(({ id }) => id === sessionId)) return;
    if (sessionId) rememberSession(sessionId);
    savedLocation.current = pathname;
    rememberLocation(pathname);
  }, [pathname, ready.data, rememberLocation, sessionId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  function openSession(id?: string, runId?: string) {
    dispatch(actions.setDrawer(undefined));
    if (!id) void navigate({ to: '/sessions' });
    else if (runId)
      void navigate({ to: '/sessions/$sessionId/trace/$runId', params: { sessionId: id, runId } });
    else void navigate({ to: '/sessions/$sessionId', params: { sessionId: id } });
  }
  function openView(next: View) {
    dispatch(actions.setDrawer(undefined));
    if (next === 'settings') void navigate({ to: settingsPaths.models });
    else if (next === 'chat') {
      if (view === 'chat' && sessionId) return;
      const saved = lastSession() ?? ready.data?.workspaceLastSession;
      openSession(
        ready.data?.sessions.find(({ id }) => id === saved)?.id ?? ready.data?.sessions[0]?.id,
      );
    } else void navigate({ to: collectionPaths[next] });
  }
  function openTrace(runId: string) {
    if (sessionId) openSession(sessionId, runId);
  }
  function selectTab(next: Tab) {
    if (!sessionId) return;
    const params = { sessionId };
    if (next === 'trace') void navigate({ to: '/sessions/$sessionId/trace', params });
    else if (next === 'artifacts') void navigate({ to: '/sessions/$sessionId/artifacts', params });
    else if (tab !== 'conversation') void navigate({ to: '/sessions/$sessionId', params });
  }
  async function revalidate(id: string) {
    void client.invalidateQueries({ queryKey: keys.sessions });
    void client.invalidateQueries({ queryKey: keys.runs });
    await client.invalidateQueries({ queryKey: keys.snapshot(id) });
  }
  async function continueFromMessage(
    sourceSessionId: string,
    messageId: string,
    rewindFromHead?: string,
  ) {
    if (forking.current) throw new Error(t('session.actionBusy'));
    const sourcePath = router.state.location.pathname;
    const key = JSON.stringify([sourceSessionId, messageId, rewindFromHead]);
    const idempotencyKey = forkKeys.current.get(key) ?? crypto.randomUUID();
    forkKeys.current.set(key, idempotencyKey);
    forking.current = true;
    try {
      const { session: child } = await forkSession.mutateAsync({
        sessionId: sourceSessionId,
        messageId,
        idempotencyKey,
        rewindFromHead,
      });
      forkKeys.current.delete(key);
      void client.invalidateQueries({ queryKey: keys.bootstrap });
      void client.invalidateQueries({ queryKey: keys.sessions });
      if (router.state.location.pathname === sourcePath) {
        openSession(child.id);
      } else {
        setNotice(
          rewindFromHead
            ? t('session.rewindCreated', { title: child.title })
            : t('session.branchCreated', { title: child.title }),
        );
      }
    } finally {
      forking.current = false;
    }
  }

  const createSession = useCreateSession();
  const updateSession = useUpdateSession();
  const removeSession = useDeleteSession();
  const [managingSession, setManagingSession] = useState(false);
  const managingLock = useRef(false);
  const [managementError, setManagementError] = useState('');
  async function createProjectSession(id: string) {
    const { session: created } = await createSession.mutateAsync(id);
    openSession(created.id);
    void client.invalidateQueries({ queryKey: keys.bootstrap });
    void client.invalidateQueries({ queryKey: keys.sessions });
  }
  async function manageSession({
    type,
    session: target,
  }: {
    type: SessionAction;
    session: Session;
  }) {
    if (managingLock.current) return;
    managingLock.current = true;
    setManagingSession(true);
    setManagementError('');
    try {
      if (type === 'delete') {
        await deleteDraft(target.id, () => removeSession.mutateAsync(target.id));
        if (workspaceSessionId(router.state.location.pathname) === target.id) {
          const remaining = ready.data?.sessions.filter(({ id }) => id !== target.id) ?? [];
          const next =
            remaining.find(
              (item) => item.projectId === target.projectId && item.status === 'active',
            ) ?? remaining[0];
          openSession(next?.id);
        }
        client.removeQueries({ queryKey: keys.snapshot(target.id), exact: true });
        void client.invalidateQueries({ queryKey: keys.sessions });
      } else {
        if (type === 'restore') {
          const { workspace } = await client.fetchQuery(sessionSnapshotOptions(target.id));
          if (workspace && workspace.state !== 'ready') {
            openSession(target.id);
            setSessionChange(undefined);
            return;
          }
        }
        await updateSession.mutateAsync({
          id: target.id,
          ...(type === 'rename'
            ? { title: title.trim() }
            : { status: type === 'archive' ? 'archived' : 'active' }),
        });
        void revalidate(target.id);
        void client.invalidateQueries({ queryKey: gitKeys.project(target.projectId) });
      }
      setSessionChange(undefined);
      await client.invalidateQueries({ queryKey: keys.bootstrap });
    } catch (error) {
      setManagementError(translateError(error, t('session.actionFailed')));
    } finally {
      managingLock.current = false;
      setManagingSession(false);
    }
  }
  const stopRun = useStopRun();
  const retryRun = useRetryRun();
  const upgradeAgent = useUpgradeSessionAgent();
  function showSessionError(error: unknown) {
    setNotice(translateError(error, t('session.actionFailed')));
  }
  function retrySessionRun(id: string, sessionId: string) {
    const idempotencyKey = retryKeys.current.get(id) ?? crypto.randomUUID();
    retryKeys.current.set(id, idempotencyKey);
    void retryRun.mutateAsync({ id, sessionId, idempotencyKey }).then(() => {
      if (retryKeys.current.get(id) === idempotencyKey) retryKeys.current.delete(id);
    }, showSessionError);
  }
  function openSessionAction(type: SessionAction, target: Session) {
    if (managingSession) return;
    dispatch(actions.setDrawer(undefined));
    setManagementError('');
    sessionActionTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSessionChange({ type, session: target });
    setTitle(target.title);
  }
  const sideProps = {
    project,
    current: sessionId,
    view,
    projects: ready.data?.projects,
    onSessionAction: openSessionAction,
    onNewProject: (id: string) =>
      void createProjectSession(id).catch((error: Error) =>
        setNotice(translateError(error, t('session.actionFailed'))),
      ),
    artifactCount: ready.data?.artifacts.length,
    sessions: ready.data?.sessions,
    sessionsFailed: ready.isError,
    onRetrySessions: () => void ready.refetch(),
    onSession: openSession,
    onView: openView,
    onNew: () =>
      project?.available
        ? void createProjectSession(project.id).catch((error: Error) =>
            setNotice(translateError(error, t('session.actionFailed'))),
          )
        : setProjectsOpen(true),
    onProjects: () => {
      dispatch(actions.setDrawer(undefined));
      setProjectsOpen(true);
    },
    onSettings: () => openView('settings'),
  };
  const pendingPermissions =
    snapshot?.permissions.filter((item) => item.status === 'pending').length ?? 0;
  const changesLabel = pendingPermissions
    ? t('changes.pending', { count: pendingPermissions })
    : t('changes.title');
  const browserPanel = previewProject ? (
    <PanelHost
      definition={panels.browser}
      view={{
        instance: {
          instanceId: `browser:${previewProject}`,
          panelId: 'atelier.browser',
          target: { scope: 'project', projectId: previewProject },
        },
        visible: browserActive,
        expanded: false,
        expandable: false,
        onRequestExpand: () => {},
        onRequestHide: closeBrowser,
        desktop,
        state: nativeBrowser,
        preview: { frame: browser.data?.frame, error: browser.isError },
      }}
    />
  ) : null;
  const terminalPanel =
    sessionId && project ? (
      <PanelHost
        definition={panels.terminal}
        view={{
          instance: {
            instanceId: `terminal:${sessionId}`,
            panelId: 'atelier.terminal',
            target: { scope: 'session', projectId: project.id, sessionId },
          },
          visible: panel.terminalActive,
          expanded: panel.terminalFullWindow,
          expandable: canDockGit,
          onRequestExpand: () => panel.expandTerminal((current) => !current),
          onRequestHide: panel.closeTerminal,
          expectedWorkspaceId: panel.expectedWorkspaceId,
          canCreate: panel.terminalCanCreate,
          archived: snapshot?.session.status === 'archived',
          launch: panel.terminalLaunch,
        }}
      />
    ) : null;
  const archiveLabel = sessionChange ? t(sessionActions[sessionChange.type]) : '';
  const sessionTitle = snapshot?.session.title;
  return (
    <div
      className={cn(
        'app react-workspace',
        desktop && 'desktop-workspace',
        browserActive && 'browser-preview-open',
      )}
    >
      <WorkspacePanels
        layout={layout}
        width={width}
        showLeft={showLeft}
        showRight={Boolean(gitBoard) || panel.terminalActive || showBrowserRight}
        focusRight={gitFullWindow || panel.terminalFullWindow}
        rightPane={
          gitBoard
            ? {
                width: gitWidth ?? Math.min(1030, Math.max(550, Math.round(width * 0.46))),
                minWidth: 450,
                maxWidth: 1440,
                resizeLabel: git('board.resize'),
                onResize: setGitWidth,
              }
            : panel.terminalActive
              ? {
                  width: panel.terminalWidth,
                  minWidth: panels.terminal.manifest.layout.minWidth,
                  maxWidth: panels.terminal.manifest.layout.maxWidth,
                  resizeLabel: terminal('resize'),
                  onResize: panel.setTerminalWidth,
                }
              : undefined
        }
        onChange={changeLayout}
        left={
          <Sidebar
            {...sideProps}
            collapsed={layout.collapsed}
            onToggleCollapsed={() => changeLayout({ ...layout, collapsed: !layout.collapsed })}
          />
        }
        right={
          gitBoard ? (
            <PanelHost
              definition={panels.git}
              view={{
                instance: gitBoard.instance,
                visible: true,
                expanded: gitFullWindow,
                expandable: canDockGit,
                onRequestExpand: () => expandGit((current) => !current),
                onRequestHide: () => closeGit(),
                board: {
                  project: gitBoard.project,
                  initialTree: gitBoard.tree,
                  initialTab: gitBoard.tab,
                  busy: gitBusy,
                  onBusy: (busy) => panel.reportGitBusy(gitBoard.instance.instanceId, busy),
                  onQuoteCode: canQuoteGit ? quoteGitCode : undefined,
                  onCreated: (id) => {
                    closeGit(false, true);
                    openSession(id);
                    void client.invalidateQueries({ queryKey: keys.bootstrap });
                    void client.invalidateQueries({ queryKey: keys.sessions });
                  },
                },
              }}
            />
          ) : panel.terminalActive ? (
            terminalPanel
          ) : (
            <aside className="react-side" aria-label={t('browser.title')}>
              {showBrowserRight ? browserPanel : null}
            </aside>
          )
        }
        center={
          <main className="main">
            <WorkspaceToolbar
              projectName={project?.name}
              projectPath={project?.path}
              onOpenProjects={sideProps.onProjects}
              sessionNavigation={
                view === 'chat' && sessionId && (!browserActive || showBrowserRight) ? (
                  <div
                    role="tablist"
                    className="session-tabs workspace-session-tabs"
                    aria-label={t('session.content')}
                  >
                    {tabs.map(({ id, labelKey, Icon }) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        className="session-tab"
                        id={`${sessionContentId}-${id}`}
                        aria-controls={`${sessionContentId}-panel`}
                        aria-selected={tab === id}
                        aria-label={t(labelKey)}
                        aria-description={
                          id === 'trace'
                            ? t('tab.toolCount', { count: snapshot?.tools.length ?? 0 })
                            : id === 'artifacts'
                              ? t('tab.artifactCount', { count: snapshot?.artifacts.length ?? 0 })
                              : undefined
                        }
                        title={t(labelKey)}
                        tabIndex={tab === id ? 0 : -1}
                        onClick={() => selectTab(id)}
                        onKeyDown={(event) => {
                          const index = tabs.findIndex((item) => item.id === id);
                          const indexes: Record<string, number> = {
                            ArrowLeft: (index - 1 + tabs.length) % tabs.length,
                            ArrowRight: (index + 1) % tabs.length,
                            Home: 0,
                            End: tabs.length - 1,
                          };
                          const next = tabs[indexes[event.key] ?? -1];
                          if (!next) return;
                          event.preventDefault();
                          document.getElementById(`${sessionContentId}-${next.id}`)?.focus();
                          selectTab(next.id);
                        }}
                      >
                        <Icon aria-hidden="true" />
                        {id === 'trace' && snapshot?.tools.length ? (
                          <span className="tab-count" aria-hidden="true">
                            {numberFormat.format(snapshot.tools.length)}
                          </span>
                        ) : null}
                        {id === 'artifacts' && snapshot?.artifacts.length ? (
                          <span className="tab-count" aria-hidden="true">
                            {numberFormat.format(snapshot.artifacts.length)}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : undefined
              }
              title={
                view === 'chat' ? (sessionTitle ?? t('tab.conversation')) : t(sectionNames[view])
              }
              connected={connected}
              canGoBack={canGoBack}
              gitAction={
                project
                  ? {
                      open: gitBoard?.project.id === project.id,
                      busy: gitBusy,
                      trigger: gitTrigger,
                      onToggle: () =>
                        gitBoard?.project.id === project.id ? closeGit() : openGit(project),
                    }
                  : undefined
              }
              onBack={() => router.history.back()}
              onForward={() => router.history.forward()}
              onOpenNavigation={() => openDrawer('navigation')}
              sessionActions={
                view === 'chat' && sessionId
                  ? {
                      browserOpen: browserActive,
                      browserTrigger,
                      onToggleBrowser: panel.toggleBrowser,
                      terminalOpen: panel.terminalActive,
                      terminalTrigger: panel.terminalTrigger,
                      terminalDisabled: gitBusy || panel.terminalLoading,
                      onToggleTerminal: panel.toggleTerminal,
                    }
                  : undefined
              }
            />
            <div className="react-center">
              {browserActive && !showBrowserRight ? (
                browserPanel
              ) : (
                <>
                  {ready.isError ? (
                    <div className="px-5 py-4" role="alert">
                      <p>{translateError(ready.error, t('connection.failed'))}</p>
                      <Button variant="secondary" onClick={() => void ready.refetch()}>
                        {t('retry')}
                      </Button>
                    </div>
                  ) : null}
                  <Suspense fallback={loading}>
                    {view === 'settings' && (
                      <Settings
                        section={section}
                        onSectionChange={(next: SettingsSection) =>
                          void navigate({ to: settingsPaths[next] })
                        }
                        onBack={() => openView('chat')}
                        layout={{
                          layout,
                          pending: updateLayout.isPending,
                          error: updateLayout.error?.message,
                          onApply: changeLayout,
                        }}
                      />
                    )}
                    {view === 'agents' ? (
                      <div className="react-collections">
                        <AgentsPage
                          projects={ready.data?.projects ?? []}
                          projectId={project?.id}
                          onOpenSession={(id) => openSession(id)}
                        />
                      </div>
                    ) : null}
                    {view === 'extensions' ? (
                      <div className="react-collections">
                        <ExtensionsPage
                          projects={ready.data?.projects ?? []}
                          projectId={project?.id}
                          onStartSkill={async (projectId, selection, editable) => {
                            const { session } = await createSession.mutateAsync(projectId);
                            await updateSessionDraft({
                              sessionId: session.id,
                              draft: {
                                ...session.draft,
                                extensionSelections: [selection],
                                mode: editable ? 'edit' : 'readonly',
                                executionPreference: 'project-v1',
                                approvalMode: undefined,
                              },
                            });
                            openSession(session.id);
                            void revalidate(session.id);
                          }}
                        />
                      </div>
                    ) : null}
                    {view === 'runs' || view === 'artifacts' ? (
                      <div className="react-collections">
                        <Collections
                          view={view}
                          projects={ready.data?.projects ?? []}
                          onOpenRun={(run) => openSession(run.sessionId, run.id)}
                        />
                      </div>
                    ) : null}
                    {view === 'chat' ? (
                      <section
                        className="conversation-screen"
                        aria-label={t('session.workspace')}
                        data-has-session={Boolean(sessionId)}
                        data-has-context={Boolean(
                          snapshot?.agent || snapshot?.workspace || snapshot?.session.fork,
                        )}
                      >
                        {sessionId &&
                        (snapshot?.agent || snapshot?.workspace || snapshot?.session.fork) ? (
                          <header className="session-header">
                            <div className="session-title-row">
                              {snapshot?.agent?.canUpgrade ? (
                                <Button
                                  size="sm"
                                  disabled={upgradeAgent.isPending}
                                  onClick={() =>
                                    upgradeAgent.mutate(
                                      {
                                        sessionId: snapshot.session.id,
                                        revisionId: snapshot.agent!.revisionId,
                                      },
                                      {
                                        onSuccess: () => revalidate(snapshot.session.id),
                                        onError: showSessionError,
                                      },
                                    )
                                  }
                                >
                                  {t('session.useNewVersion')}
                                </Button>
                              ) : null}
                              {snapshot?.agent ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openView('agents')}
                                  title={t('session.manageAgent')}
                                >
                                  {t('session.agentVersion', {
                                    name: snapshot.agent.name,
                                    version: snapshot.agent.version,
                                  })}
                                </Button>
                              ) : null}
                            </div>
                            {snapshot?.workspace ? (
                              <SessionWorktree
                                session={snapshot.session}
                                workspace={snapshot.workspace}
                                onShowTree={() => openGit(snapshot.project, 'worktrees')}
                                onRefresh={async () => {
                                  await revalidate(snapshot.session.id);
                                  void client.invalidateQueries({ queryKey: keys.bootstrap });
                                }}
                              />
                            ) : null}
                            {snapshot?.session.fork
                              ? (() => {
                                  const origin = snapshot.session.fork;
                                  const label =
                                    origin.kind === 'rewind'
                                      ? t('session.beforeRewind')
                                      : t('session.source');
                                  const exists = ready.data?.sessions.some(
                                    (item) => item.id === origin.sourceSessionId,
                                  );
                                  return exists ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() =>
                                        void navigate({
                                          to: '/sessions/$sessionId/messages/$messageId',
                                          params: {
                                            sessionId: origin.sourceSessionId,
                                            messageId: origin.sourceMessageId,
                                          },
                                        })
                                      }
                                    >
                                      {label} · {origin.sourceTitle}
                                    </Button>
                                  ) : (
                                    <p className="session-meta">
                                      {t('session.sourceUnavailable', {
                                        label,
                                        title: origin.sourceTitle,
                                      })}
                                    </p>
                                  );
                                })()
                              : null}
                          </header>
                        ) : null}
                        <div
                          className="react-conversation-body"
                          id={sessionId ? `${sessionContentId}-panel` : undefined}
                          role={sessionId ? 'tabpanel' : undefined}
                          aria-labelledby={sessionId ? `${sessionContentId}-${tab}` : undefined}
                        >
                          {sessionId && tab === 'trace' ? (
                            <div className="flex shrink-0 items-center py-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="session-changes-button"
                                data-pending={pendingPermissions > 0 || undefined}
                                aria-label={t('changes.title')}
                                aria-description={pendingPermissions ? changesLabel : undefined}
                                aria-haspopup="dialog"
                                onClick={() => openDrawer('details')}
                              >
                                <FileDiff data-icon="inline-start" aria-hidden="true" />
                                {changesLabel}
                              </Button>
                            </div>
                          ) : null}
                          <Suspense fallback={loading}>
                            {snapshot && tab === 'conversation' ? (
                              <SessionChat
                                key={snapshot.session.id}
                                snapshot={snapshot}
                                defaultModel={ready.data?.config.model ?? ''}
                                nativeExecution={ready.data?.capabilities.nativeExecution === true}
                                onOpenLink={
                                  desktop
                                    ? async (url, destination) => {
                                        const bridge = window.atelierDesktop;
                                        if (!bridge) throw new Error(t('browser.disabled'));
                                        if (destination === 'internal') openBrowser();
                                        await bridge.command(
                                          snapshot.project.id,
                                          destination === 'internal' ? 'open-tab' : 'open-external',
                                          url,
                                        );
                                      }
                                    : undefined
                                }
                                onForkMessage={(messageId) => {
                                  void continueFromMessage(snapshot.session.id, messageId).catch(
                                    (error: unknown) => {
                                      setNotice(
                                        translateError(error, t('session.createBranchFailed')),
                                      );
                                    },
                                  );
                                }}
                                onRewindMessage={(messageId, expectedHeadId) =>
                                  continueFromMessage(
                                    snapshot.session.id,
                                    messageId,
                                    expectedHeadId,
                                  )
                                }
                                forkingMessageId={
                                  forkSession.isPending &&
                                  !forkSession.variables?.rewindFromHead &&
                                  forkSession.variables?.sessionId === snapshot.session.id
                                    ? forkSession.variables.messageId
                                    : undefined
                                }
                                focusMessageId={messageId}
                                onSent={revalidate}
                                onError={setNotice}
                                onStop={(id) =>
                                  void stopRun
                                    .mutateAsync({ id, sessionId: snapshot.session.id })
                                    .catch(showSessionError)
                                }
                                onRetry={(id) => retrySessionRun(id, snapshot.session.id)}
                                onTrace={openTrace}
                              />
                            ) : null}
                            {snapshot && tab === 'trace' ? (
                              <div className="react-scroll-view">
                                <RunTrace
                                  snapshot={snapshot}
                                  runId={selectedRun?.id}
                                  onSelect={openTrace}
                                />
                              </div>
                            ) : null}
                            {snapshot && tab === 'artifacts' ? (
                              <div className="react-scroll-view">
                                <Collections
                                  view="artifacts"
                                  projects={[snapshot.project]}
                                  sessionId={snapshot.session.id}
                                  onOpenRun={(run: Run) => openSession(run.sessionId, run.id)}
                                />
                              </div>
                            ) : null}
                            {!snapshot ? (
                              session.isError ? (
                                <div role="alert" className="empty-text">
                                  <p>{translateError(session.error, t('session.loadFailed'))}</p>
                                  <Button
                                    variant="secondary"
                                    onClick={() => void session.refetch()}
                                  >
                                    {t('retry')}
                                  </Button>
                                </div>
                              ) : sessionId || ready.isPending ? (
                                loading
                              ) : (
                                <div className="workspace-welcome">
                                  <span className="workspace-welcome-icon" aria-hidden="true">
                                    <FolderOpen />
                                  </span>
                                  <h1>{t('home.title')}</h1>
                                  <p>{t('home.description')}</p>
                                  <Button onClick={sideProps.onProjects}>
                                    {t('home.bindProject')}
                                  </Button>
                                </div>
                              )
                            ) : null}
                          </Suspense>
                        </div>
                      </section>
                    ) : null}
                  </Suspense>
                </>
              )}
            </div>
          </main>
        }
      />
      <Dialog
        open={!!drawer}
        onOpenChange={(open) => {
          if (!open) dispatch(actions.setDrawer(undefined));
        }}
      >
        <DialogContent
          className={drawer === 'details' ? 'workspace-changes-dialog' : 'react-drawer'}
          onCloseAutoFocus={(event) => {
            const trigger = drawerTrigger.current;
            if (trigger?.isConnected) {
              event.preventDefault();
              trigger.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader className={drawer === 'details' ? undefined : 'sr-only'}>
            <DialogTitle>
              {drawer === 'details' ? t('changes.title') : t('drawer.navigation')}
            </DialogTitle>
            <DialogDescription>
              {drawer === 'details' ? t('changes.description') : t('navigation.home')}
            </DialogDescription>
          </DialogHeader>
          {drawer === 'navigation' ? <Sidebar {...sideProps} /> : null}
          {drawer === 'details' ? (
            session.isError ? (
              <div role="alert">
                <p>{translateError(session.error, t('session.loadFailed'))}</p>
                <Button variant="secondary" onClick={() => void session.refetch()}>
                  {t('retry')}
                </Button>
              </div>
            ) : (
              <Suspense fallback={loading}>
                <SessionChanges snapshot={snapshot} />
              </Suspense>
            )
          ) : null}
        </DialogContent>
      </Dialog>
      {projectsOpen ? (
        <ProjectsDialog
          open
          onOpenChange={setProjectsOpen}
          projects={ready.data?.projects ?? []}
          onChoose={async (id) => {
            await createProjectSession(id);
          }}
          onGit={(project) => {
            openGit(project);
            setProjectsOpen(false);
          }}
        />
      ) : null}
      <Dialog
        open={!!sessionChange}
        onOpenChange={(open) => {
          if (!open && !managingSession) setSessionChange(undefined);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            const trigger = sessionActionTrigger.current;
            if (trigger?.isConnected) {
              event.preventDefault();
              trigger.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{archiveLabel}</DialogTitle>
            <DialogDescription>{sessionChange?.session.title}</DialogDescription>
          </DialogHeader>
          {sessionChange?.type === 'rename' ? (
            <label className="grid gap-2">
              {t('session.name')}
              <input
                className="field"
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          ) : null}
          {sessionChange?.type === 'delete' ? (
            <p className="text-sm">{t('session.deleteWarning')}</p>
          ) : null}
          {managementError && (
            <p role="alert" className="text-sm text-destructive">
              {managementError}
            </p>
          )}
          <div className="dialog-actions">
            <Button
              variant="secondary"
              disabled={managingSession}
              onClick={() => setSessionChange(undefined)}
            >
              {t('cancel')}
            </Button>
            <Button
              variant={sessionChange?.type === 'delete' ? 'destructive' : 'default'}
              disabled={managingSession || (sessionChange?.type === 'rename' && !title.trim())}
              onClick={() => {
                if (sessionChange) void manageSession(sessionChange);
              }}
            >
              {archiveLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <WorkspaceNotice message={notice} />
    </div>
  );
}
