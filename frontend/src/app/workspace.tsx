/**
 * @file 编排工作区、会话及各功能页面。
 * @implementation 按路由装配会话、执行轨迹和设置，保存浏览器返回位置，并按需打开网页面板或会话变更记录。
 * @updated 2026-11-22T18:47:41+08:00
 */
import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, Globe, X } from 'lucide-react';
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
import type { Run, Session } from '@shared/types';
import { initialWorkspaceLayout, type WorkspaceLayout } from '@shared/workspace-layout';
import { useWorkspaceLayout } from '@/use-query/settings/use-workspace-layout';
import { useUpdateWorkspaceLayout } from '@/use-query/settings/use-update-workspace-layout';
import { useCreateSession } from '@/use-query/sessions/use-create-session';
import { useUpdateSession } from '@/use-query/sessions/use-update-session';
import { useDeleteSession } from '@/use-query/sessions/use-delete-session';
import { updateSessionDraft } from '@/use-query/sessions/use-update-session-draft';
import { WorkspacePanels, useWorkspaceViewport } from './workspace-panels';
import { api, bootstrap } from '@/api/client';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import { translateError, useUiTranslation } from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { deleteDraft, lastSession, rememberSession } from './drafts';
import { keys, useRunEvents } from './events';
import { ProjectsDialog } from './projects';
import { Sidebar } from './sidebar';
import { BrowserPreview } from './browser-preview';
import { useBrowserPreview } from '@/use-query/browser/use-browser-preview';
import { useForkSession } from '@/use-query/sessions/use-fork-session';
import { useUpgradeSessionAgent } from '@/use-query/sessions/use-upgrade-session-agent';
import { useStopRun } from '@/use-query/runs/use-stop-run';
import { useRetryRun } from '@/use-query/runs/use-retry-run';
import { DesktopBrowser, useDesktopBrowser } from './desktop-browser';
import { actions, type Tab, useAppDispatch, useWorkspace, type View } from './store';

const SessionChat = lazy(() => import('./session-chat'));
const ExtensionsPage = lazy(() => import('@/features/extensions'));
const AgentsPage = lazy(() => import('@/features/agents'));
declare module '@tanstack/react-router' {
  interface HistoryState {
    workspaceBrowserReturn?: string;
  }
}

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
type SettingsSection = 'models' | 'layout' | 'diagnostics';
const settingsPaths = {
  models: '/settings/models',
  layout: '/settings/layout',
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
  { id: 'conversation', labelKey: 'tab.conversation' },
  { id: 'trace', labelKey: 'tab.trace' },
  { id: 'artifacts', labelKey: 'section.artifacts' },
] as const;
const active = new Set(['queued', 'running', 'awaiting_permission', 'stopping']);

type SessionAction = 'rename' | 'archive' | 'restore' | 'delete';
const sessionActions = {
  rename: 'session.rename',
  archive: 'session.archive',
  restore: 'session.restore',
  delete: 'session.delete',
} as const;

export default function Workspace() {
  const { t, locale } = useUiTranslation('workbench');
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
  const browserOpen = pathname.endsWith('/browser');
  const savedBrowserReturn = location.state.workspaceBrowserReturn;
  const browserReturnPath =
    savedBrowserReturn &&
    isWorkspaceLocation(savedBrowserReturn) &&
    workspaceSessionId(savedBrowserReturn) === sessionId &&
    !savedBrowserReturn.endsWith('/browser')
      ? savedBrowserReturn
      : undefined;
  const contentPath = browserOpen ? (browserReturnPath ?? `/sessions/${sessionId}`) : pathname;
  const trace = browserOpen ? contentPath.match(/\/trace\/([^/]+)$/u)?.[1] : routeRunId;
  const messageId = browserOpen ? contentPath.match(/\/messages\/([^/]+)$/u)?.[1] : routeMessageId;
  const view = currentView(pathname);
  const tab: Tab = contentPath.includes('/trace')
    ? 'trace'
    : sessionId && contentPath.endsWith('/artifacts')
      ? 'artifacts'
      : 'conversation';
  const section: SettingsSection =
    pathname === settingsPaths.layout
      ? 'layout'
      : pathname === settingsPaths.diagnostics
        ? 'diagnostics'
        : 'models';
  const drawer = useWorkspace((state) => state.workspace.drawer);
  const connected = useWorkspace((state) => state.workspace.connected);
  const ready = useQuery({ queryKey: keys.bootstrap, queryFn: bootstrap, staleTime: 30_000 });
  const session = useQuery({
    queryKey: keys.snapshot(sessionId),
    enabled: !!sessionId,
    queryFn: ({ signal }) =>
      api<Snapshot>(`/api/sessions/${encodeURIComponent(sessionId!)}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      }),
    // Keep approvals visible if the browser temporarily misses an event.
    refetchInterval: ({ state }) =>
      state.data?.runs.some((run) => active.has(run.status)) ? 3000 : false,
  });
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
  const browser = useBrowserPreview(desktop || !browserOpen ? undefined : previewProject, true);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const layoutQuery = useWorkspaceLayout();
  const updateLayout = useUpdateWorkspaceLayout();
  const [localLayout, setLocalLayout] = useState<WorkspaceLayout>();
  const width = useWorkspaceViewport();
  const layout = localLayout ?? layoutQuery.data ?? initialWorkspaceLayout;
  const showLeft = width >= 768;
  const showRight = view === 'chat' && browserOpen && (width > 1120 || (width >= 900 && desktop));
  const browserTrigger = useRef<HTMLButtonElement>(null);
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
  useRunEvents(client, ready.data?.cursor);

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
  function openBrowser() {
    if (!sessionId || browserOpen) return;
    dispatch(actions.setDrawer(undefined));
    void navigate({
      to: '/sessions/$sessionId/browser',
      params: { sessionId },
      state: { workspaceBrowserReturn: pathname },
    });
  }
  function closeBrowser() {
    if (!sessionId || !browserOpen) return;
    if (browserReturnPath && canGoBack) router.history.back();
    else void navigate({ to: '/sessions/$sessionId', params: { sessionId }, replace: true });
    browserTrigger.current?.focus({ preventScroll: true });
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
        await updateSession.mutateAsync({
          id: target.id,
          ...(type === 'rename'
            ? { title: title.trim() }
            : { status: type === 'archive' ? 'archived' : 'active' }),
        });
        void revalidate(target.id);
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
  const browserPanel = (
    <section className="workspace-browser-panel" aria-label={t('browser.panel')}>
      <header className="workspace-browser-heading">
        <h2>
          <Globe aria-hidden="true" />
          {t('browser.title')}
        </h2>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={t('browser.close')}
          onClick={closeBrowser}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      {desktop && previewProject ? (
        <DesktopBrowser key={previewProject} projectId={previewProject} state={nativeBrowser} />
      ) : (
        <BrowserPreview frame={browser.data?.frame} error={browser.isError} />
      )}
    </section>
  );
  const archiveLabel = sessionChange ? t(sessionActions[sessionChange.type]) : '';
  const sessionTitle = snapshot?.session.title;
  return (
    <div
      className={cn(
        'app react-workspace',
        desktop && 'desktop-workspace',
        browserOpen && 'browser-preview-open',
      )}
    >
      <WorkspacePanels
        layout={layout}
        width={width}
        showLeft={showLeft}
        showRight={showRight}
        onChange={changeLayout}
        left={
          <Sidebar
            {...sideProps}
            collapsed={layout.collapsed}
            onToggleCollapsed={() => changeLayout({ ...layout, collapsed: !layout.collapsed })}
          />
        }
        right={
          <aside className="react-side" aria-label={t('browser.title')}>
            {showRight ? browserPanel : null}
          </aside>
        }
        center={
          <main className="main">
            <WorkspaceToolbar
              projectName={project?.name}
              title={
                view === 'chat' ? (sessionTitle ?? t('tab.conversation')) : t(sectionNames[view])
              }
              connected={connected}
              canGoBack={canGoBack}
              onBack={() => router.history.back()}
              onForward={() => router.history.forward()}
              onOpenNavigation={() => openDrawer('navigation')}
              onOpenSettings={sideProps.onSettings}
              sessionActions={
                view === 'chat' && sessionId
                  ? {
                      pendingPermissions,
                      browserOpen,
                      browserTrigger,
                      onOpenChanges: () => openDrawer('details'),
                      onToggleBrowser: browserOpen ? closeBrowser : openBrowser,
                    }
                  : undefined
              }
            />
            <div className="react-center">
              {browserOpen && !showRight ? (
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
                      >
                        {sessionId ? (
                          <>
                            <header className="session-header">
                              <div className="session-title-row">
                                <h1 title={sessionTitle}>{sessionTitle ?? t('session.begin')}</h1>
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
                              {project ? (
                                <p className="session-meta">
                                  {project.branch || t('session.localDirectory')} <span>·</span>{' '}
                                  {snapshot?.session.fork
                                    ? t('session.sharedDirectory')
                                    : t('session.localWorkspace')}
                                </p>
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
                            <div
                              role="tablist"
                              className="session-tabs"
                              aria-label={t('session.content')}
                            >
                              {tabs.map(({ id, labelKey }) => (
                                <button
                                  key={id}
                                  type="button"
                                  role="tab"
                                  className="session-tab"
                                  id={`${sessionContentId}-${id}`}
                                  aria-controls={`${sessionContentId}-panel`}
                                  aria-selected={tab === id}
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
                                    document
                                      .getElementById(`${sessionContentId}-${next.id}`)
                                      ?.focus();
                                    selectTab(next.id);
                                  }}
                                >
                                  {t(labelKey)}
                                  {id === 'trace' && snapshot?.tools.length
                                    ? ` ${numberFormat.format(snapshot.tools.length)}`
                                    : ''}
                                  {id === 'artifacts' && snapshot?.artifacts.length
                                    ? ` ${numberFormat.format(snapshot.artifacts.length)}`
                                    : ''}
                                </button>
                              ))}
                            </div>
                          </>
                        ) : null}
                        <div
                          className="react-conversation-body"
                          id={sessionId ? `${sessionContentId}-panel` : undefined}
                          role={sessionId ? 'tabpanel' : undefined}
                          aria-labelledby={sessionId ? `${sessionContentId}-${tab}` : undefined}
                        >
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
