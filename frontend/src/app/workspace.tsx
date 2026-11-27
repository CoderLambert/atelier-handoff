/**
 * @file 编排工作区外壳、布局面板与功能视图组合。
 * @implementation 组合导航、查询缓存、工作区面板、会话管理控制器与快捷键宿主，并将浏览器订阅下沉到面板边界、会话动作下沉到 SessionChat。
 * @updated 2026-11-27T19:25:00+08:00
 */
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Activity, FileDiff, FileText, FolderOpen, MessagesSquare } from 'lucide-react';
import type { Run, Session } from '@shared/types';
import type { WorkspaceLayout } from '@shared/workspace-layout';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/components/ui/utils';
import type { QuoteGitCode } from '@/features/git/git-code-selection';
import { SessionWorktree } from '@/features/git/session-worktree';
import { ShortcutHost, useShortcutCommandLabels, type ShortcutCommand } from '@/features/shortcuts';
import { translateError, useUiTranslation } from '@/i18n';
import { useCreateSession } from '@/use-query/sessions/use-create-session';
import { useSessionSnapshot } from '@/use-query/sessions/use-session-snapshot';
import { updateSessionDraft } from '@/use-query/sessions/use-update-session-draft';
import { useUpgradeSessionAgent } from '@/use-query/sessions/use-upgrade-session-agent';
import { useUpdateWorkspaceLayout } from '@/use-query/settings/use-update-workspace-layout';
import { useWorkspaceLayout } from '@/use-query/settings/use-workspace-layout';
import { useBootstrap } from '@/use-query/workspace/use-bootstrap';
import { useWorkspaceCache } from '@/use-query/workspace/use-workspace-cache';
import { useWorkspaceEvents } from '@/use-query/workspace/use-workspace-events';
import { appendFileQuote, lastSession } from './drafts';
import { PanelHost } from './panels/panel-host';
import { panels } from './panels/registry';
import { useWorkspacePanel } from './panels/use-workspace-panel';
import { ProjectsDialog } from './projects';
import {
  SessionManagementController,
  type SessionActionRequest,
} from './session-management-controller';
import { adjacentSessionId, sessionSwitchItems } from './session-switcher-model';
import { Sidebar } from './sidebar';
import { actions, useAppDispatch, useWorkspace } from './store';
import type { SessionAction } from './types';
import { useWorkspaceNavigation } from './use-workspace-navigation';
import { WorkspaceNotice } from './workspace-notice';
import { WorkspacePanels, useWorkspaceViewport } from './workspace-panels';
import { WorkspaceSessionSwitcher } from './workspace-session-switcher';
import {
  applyLayoutOverride,
  releaseLayoutOverride,
  resolveWorkspaceLayout,
  type PendingLayoutOverride,
} from './workspace-state';
import { WorkspaceToolbar } from './workspace-toolbar';

const SessionChat = lazy(() => import('./session-chat'));
const ExtensionsPage = lazy(() => import('@/features/extensions'));
const AgentsPage = lazy(() => import('@/features/agents'));
const SchedulesPage = lazy(() => import('@/features/schedules'));

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
  schedules: 'section.schedules',
  settings: 'section.settings',
} as const;

const tabs = [
  { id: 'conversation', labelKey: 'tab.conversation', Icon: MessagesSquare },
  { id: 'trace', labelKey: 'tab.trace', Icon: Activity },
  { id: 'artifacts', labelKey: 'section.artifacts', Icon: FileText },
] as const;

const active = new Set(['queued', 'running', 'awaiting_permission', 'stopping']);

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
  const cache = useWorkspaceCache();
  const drawer = useWorkspace((state) => state.workspace.drawer);
  const connected = useWorkspace((state) => state.workspace.connected);
  const ready = useBootstrap();
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sessionAction, setSessionAction] = useState<SessionActionRequest>();
  const [notice, setNotice] = useState('');

  const openProjectsOnEmpty = useCallback(() => setProjectsOpen(true), []);
  const nav = useWorkspaceNavigation({
    ready: ready.data,
    onNoProjects: openProjectsOnEmpty,
  });
  const { pathname, sessionId, routePanel, trace, messageId, view, tab, section, canGoBack } = nav;

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

  const shortcutLabels = useShortcutCommandLabels();
  const width = useWorkspaceViewport();
  const panel = useWorkspacePanel({ sessionId, snapshot, width });
  const { gitBoard, gitBusy, gitTrigger, openGit, browserTrigger, openBrowser } = panel;
  const browserActive = panel.activePanel === 'browser';
  const terminalActive = panel.activePanel === 'terminal';

  const layoutQuery = useWorkspaceLayout();
  const updateLayout = useUpdateWorkspaceLayout();
  const { mutate: updateLayoutMutate } = updateLayout;
  const [pendingLayout, setPendingLayout] = useState<PendingLayoutOverride>();
  const pendingLayoutRef = useRef<PendingLayoutOverride | undefined>(undefined);
  const layout = resolveWorkspaceLayout(pendingLayout, layoutQuery.data);
  const showLeft = width >= 768;

  const createSession = useCreateSession();
  const upgradeAgent = useUpgradeSessionAgent();
  const focusGeneration = useRef(0);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const openBrowserRef = useRef(openBrowser);
  useLayoutEffect(() => {
    openBrowserRef.current = openBrowser;
  });

  useWorkspaceEvents(ready.data?.cursor, view === 'chat' ? sessionId : undefined);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  const showSessionError = useCallback(
    (error: unknown) => {
      setNotice(translateError(error, t('session.actionFailed')));
    },
    [t],
  );

  const openDrawer = useCallback(
    (next: 'navigation' | 'details') => {
      drawerTrigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dispatch(actions.setDrawer(next));
    },
    [dispatch],
  );

  const changeLayout = useCallback(
    (next: WorkspaceLayout) => {
      const override = applyLayoutOverride(pendingLayoutRef.current, next);
      pendingLayoutRef.current = override;
      setPendingLayout(override);
      updateLayoutMutate(next, {
        onSuccess: () => {
          const released = releaseLayoutOverride(pendingLayoutRef.current, override.requestId);
          pendingLayoutRef.current = released;
          setPendingLayout(released);
        },
        onError: (error) => setNotice(translateError(error, t('layout.saveFailed'))),
      });
    },
    [t, updateLayoutMutate],
  );

  const snapshotProjectId = snapshot?.project.id;
  const handleOpenDesktopLink = useCallback(
    async (url: string, destination: 'internal' | 'external') => {
      const bridge = window.atelierDesktop;
      if (!bridge || !snapshotProjectId) throw new Error(t('browser.disabled'));
      if (destination === 'internal') openBrowserRef.current();
      await bridge.command(
        snapshotProjectId,
        destination === 'internal' ? 'open-tab' : 'open-external',
        url,
      );
    },
    [snapshotProjectId, t],
  );

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
      if (tab !== 'conversation') nav.selectTab('conversation');
      if (panel.canDock && panel.fullWindow) panel.dockRight();
      if (panel.canDock && tab === 'conversation') {
        dispatch(actions.requestComposerFocus({ sessionId: snapshot.session.id }));
      }
    }
    return result;
  };

  const inputTarget = sessionId
    ? snapshot && snapshot.session.id === sessionId
      ? snapshot.session
      : ready.data?.sessions.find(({ id }) => id === sessionId)
    : (ready.data?.sessions.find(({ id, status }) => id === lastSession() && status === 'active') ??
      sessionSwitchItems(ready.data?.sessions ?? [], ready.data?.projects ?? [], '').find(
        ({ session }) => session.status === 'active',
      )?.session);
  const inputSubmitting = useWorkspace((state) =>
    Boolean(inputTarget && state.workspace.submitting[inputTarget.id]),
  );

  async function focusComposer() {
    if (
      !inputTarget ||
      inputTarget.status === 'archived' ||
      inputTarget.creatingFork ||
      inputSubmitting ||
      gitBusy
    )
      return;
    const targetId = inputTarget.id;
    const generation = ++focusGeneration.current;
    dispatch(actions.setDrawer(undefined));
    if (panel.fullWindow) panel.collapseRight(false);
    if (targetId !== sessionId || tab !== 'conversation' || messageId || view !== 'chat') {
      await nav.navigateToConversation(targetId);
    }
    if (
      focusGeneration.current === generation &&
      nav.currentContentPath(targetId) === `/sessions/${targetId}`
    ) {
      dispatch(actions.requestComposerFocus({ sessionId: targetId }));
    }
  }

  function openShortcutSession(id: string) {
    if (gitBusy) return;
    focusGeneration.current++;
    dispatch(actions.clearComposerFocus());
    if (panel.fullWindow) panel.collapseRight(false);
    nav.openSession(id);
  }

  async function createProjectSession(id: string) {
    const { session: created } = await createSession.mutateAsync(id);
    nav.openSession(created.id);
    cache.invalidateSessionLists();
  }

  const openSessionAction = useCallback(
    (type: SessionAction, target: Session) => {
      dispatch(actions.setDrawer(undefined));
      setSessionAction({
        type,
        session: target,
        trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
    },
    [dispatch],
  );
  const closeSessionAction = useCallback(() => setSessionAction(undefined), []);

  const sideProps = {
    project,
    current: sessionId,
    view,
    projects: ready.data?.projects,
    onSessionAction: openSessionAction,
    onNewProject: (id: string) => void createProjectSession(id).catch(showSessionError),
    artifactCount: ready.data?.artifacts.length,
    sessions: ready.data?.sessions,
    sessionsFailed: ready.isError,
    onRetrySessions: () => void ready.refetch(),
    onSession: nav.openSession,
    onView: nav.openView,
    onNew: () =>
      project?.available
        ? void createProjectSession(project.id).catch(showSessionError)
        : setProjectsOpen(true),
    onProjects: () => {
      dispatch(actions.setDrawer(undefined));
      setProjectsOpen(true);
    },
    onSettings: () => nav.openView('settings'),
    onOpenSwitcher: () => setSwitcherOpen(true),
  };

  const pendingPermissions =
    snapshot?.permissions.filter((item) => item.status === 'pending').length ?? 0;
  const changesLabel = pendingPermissions
    ? t('changes.pending', { count: pendingPermissions })
    : t('changes.title');

  const panelActions = {
    expanded: panel.fullWindow,
    expandable: panel.canDock,
    onRequestExpand: panel.toggleExpanded,
    onRequestHide: () => panel.collapseRight(),
  };

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
        collapsed: panel.rightCollapsed,
        ...panelActions,
        desktop,
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
          visible: terminalActive,
          ...panelActions,
          expectedWorkspaceId: panel.expectedWorkspaceId,
          canCreate: panel.terminalCanCreate,
          archived: snapshot?.session.status === 'archived',
          launch: panel.terminalLaunch,
        }}
      />
    ) : null;

  const sessionTitle = snapshot?.session.title;
  const upgradableAgent = snapshot?.agent?.canUpgrade ? snapshot.agent : undefined;
  const previousSession = adjacentSessionId(ready.data?.sessions ?? [], sessionId, -1);
  const nextSession = adjacentSessionId(ready.data?.sessions ?? [], sessionId, 1);

  const shortcutActions: {
    id: keyof typeof shortcutLabels;
    available: boolean;
    run: () => void;
  }[] = [
    {
      id: 'layout.toggleLeft',
      available: true,
      run: () =>
        showLeft
          ? changeLayout({ ...layout, collapsed: !layout.collapsed })
          : drawer === 'navigation'
            ? dispatch(actions.setDrawer(undefined))
            : openDrawer('navigation'),
    },
    {
      id: 'layout.toggleRight',
      available: Boolean(panel.activePanel) && !gitBusy,
      run: panel.toggleRight,
    },
    { id: 'sessions.switch', available: !gitBusy, run: () => setSwitcherOpen(true) },
    {
      id: 'sessions.previous',
      available: Boolean(previousSession) && !gitBusy,
      run: () => {
        if (previousSession) openShortcutSession(previousSession);
      },
    },
    {
      id: 'sessions.next',
      available: Boolean(nextSession) && !gitBusy,
      run: () => {
        if (nextSession) openShortcutSession(nextSession);
      },
    },
    {
      id: 'panels.git',
      available: Boolean(project?.available) && !gitBusy,
      run: () => {
        if (project) openGit(project);
      },
    },
    {
      id: 'panels.terminal',
      available: Boolean(sessionId && snapshot) && !gitBusy && !panel.terminalLoading,
      run: panel.openTerminal,
    },
    {
      id: 'panels.browser',
      available: Boolean(sessionId && project?.available) && !gitBusy,
      run: openBrowser,
    },
    {
      id: 'composer.focus',
      available:
        Boolean(inputTarget && inputTarget.status === 'active' && !inputTarget.creatingFork) &&
        !inputSubmitting &&
        !gitBusy,
      run: () => {
        void focusComposer();
      },
    },
    {
      id: 'shortcuts.settings',
      available: !gitBusy,
      run: () => {
        if (panel.fullWindow) panel.collapseRight(false);
        nav.openSettingsSection('shortcuts');
      },
    },
  ];
  const shortcutCommands: ShortcutCommand[] = shortcutActions.flatMap((action) => {
    const label = shortcutLabels[action.id];
    return label ? [{ ...label, ...action }] : [];
  });

  return (
    <div className={cn('app react-workspace', desktop && 'desktop-workspace')}>
      <ShortcutHost
        commands={shortcutCommands}
        contextKey={`${pathname}:${project?.id ?? ''}:${gitBoard?.instance.instanceId ?? routePanel ?? ''}:${panel.rightCollapsed}`}
      />
      <WorkspaceSessionSwitcher
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        sessions={ready.data?.sessions ?? []}
        projects={ready.data?.projects ?? []}
        current={sessionId}
        loading={ready.isPending}
        failed={ready.isError}
        onRetry={() => {
          void ready.refetch();
        }}
        onSelect={openShortcutSession}
      />
      <WorkspacePanels
        layout={layout}
        width={width}
        showLeft={showLeft}
        showRight={Boolean(panel.activePanel)}
        rightCollapsed={panel.rightCollapsed}
        focusRight={!panel.rightCollapsed && panel.fullWindow}
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
                ...panelActions,
                board: {
                  project: gitBoard.project,
                  initialTree: gitBoard.tree,
                  initialTab: gitBoard.tab,
                  busy: gitBusy,
                  onBusy: (busy) => panel.reportGitBusy(gitBoard.instance.instanceId, busy),
                  onQuoteCode: canQuoteGit ? quoteGitCode : undefined,
                  onCreated: (id) => {
                    panel.clearGit();
                    nav.openSession(id);
                    cache.invalidateSessionLists();
                  },
                },
              }}
            />
          ) : terminalActive ? (
            terminalPanel
          ) : (
            browserPanel
          )
        }
        center={
          <main className="main">
            <WorkspaceToolbar
              projectName={project?.name}
              projectPath={project?.path}
              onOpenProjects={sideProps.onProjects}
              sessionNavigation={
                view === 'chat' && sessionId ? (
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
                        onClick={() => nav.selectTab(id)}
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
                          nav.selectTab(next.id);
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
                      open: gitBoard?.project.id === project.id && !panel.rightCollapsed,
                      busy: gitBusy,
                      trigger: gitTrigger,
                      onToggle: () =>
                        gitBoard?.project.id === project.id
                          ? panel.toggleRight()
                          : openGit(project),
                    }
                  : undefined
              }
              onBack={nav.goBack}
              onForward={nav.goForward}
              onOpenNavigation={() => openDrawer('navigation')}
              sessionActions={
                view === 'chat' && sessionId
                  ? {
                      browserOpen: browserActive && !panel.rightCollapsed,
                      browserTrigger,
                      onToggleBrowser: panel.toggleBrowser,
                      terminalOpen: terminalActive && !panel.rightCollapsed,
                      terminalTrigger: panel.terminalTrigger,
                      terminalDisabled: gitBusy || panel.terminalLoading,
                      onToggleTerminal: panel.toggleTerminal,
                    }
                  : undefined
              }
            />
            <div className="react-center">
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
                    onSectionChange={nav.openSettingsSection}
                    onBack={() => nav.openView('chat')}
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
                      onOpenSession={(id) => nav.openSession(id)}
                    />
                  </div>
                ) : null}
                {view === 'schedules' ? (
                  <div className="react-collections">
                    <SchedulesPage
                      projects={ready.data?.projects ?? []}
                      sessions={ready.data?.sessions ?? []}
                      projectId={project?.id}
                      onOpenSession={(id) => nav.openSession(id)}
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
                        nav.openSession(session.id);
                        void cache.revalidateSession(session.id);
                      }}
                    />
                  </div>
                ) : null}
                {view === 'runs' || view === 'artifacts' ? (
                  <div className="react-collections">
                    <Collections
                      view={view}
                      projects={ready.data?.projects ?? []}
                      onOpenRun={(run) => nav.openSession(run.sessionId, run.id)}
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
                          {upgradableAgent && snapshot ? (
                            <Button
                              size="sm"
                              disabled={upgradeAgent.isPending}
                              onClick={() =>
                                upgradeAgent.mutate(
                                  {
                                    sessionId: snapshot.session.id,
                                    revisionId: upgradableAgent.revisionId,
                                  },
                                  { onError: showSessionError },
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
                              onClick={() => nav.openView('agents')}
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
                              await cache.revalidateSession(snapshot.session.id);
                              void cache.invalidateBootstrap();
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
                                    nav.openMessage(origin.sourceSessionId, origin.sourceMessageId)
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
                            onOpenLink={desktop ? handleOpenDesktopLink : undefined}
                            focusMessageId={messageId}
                            onSent={cache.revalidateSession}
                            onError={setNotice}
                            onTrace={nav.openTrace}
                            onOpenSession={nav.openSession}
                            getLocationPath={nav.getCurrentPath}
                          />
                        ) : null}
                        {snapshot && tab === 'trace' ? (
                          <div className="react-scroll-view">
                            <RunTrace
                              snapshot={snapshot}
                              runId={selectedRun?.id}
                              onSelect={nav.openTrace}
                            />
                          </div>
                        ) : null}
                        {snapshot && tab === 'artifacts' ? (
                          <div className="react-scroll-view">
                            <Collections
                              view="artifacts"
                              projects={[snapshot.project]}
                              sessionId={snapshot.session.id}
                              onOpenRun={(run: Run) => nav.openSession(run.sessionId, run.id)}
                            />
                          </div>
                        ) : null}
                        {!snapshot ? (
                          session.isError ? (
                            <div role="alert" className="empty-text">
                              <p>{translateError(session.error, t('session.loadFailed'))}</p>
                              <Button variant="secondary" onClick={() => void session.refetch()}>
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
            </div>
          </main>
        }
      />
      <Dialog
        open={Boolean(drawer)}
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
      <SessionManagementController
        request={sessionAction}
        sessions={ready.data?.sessions ?? []}
        getCurrentPath={nav.getCurrentPath}
        onOpenSession={nav.openSession}
        onClose={closeSessionAction}
      />
      <WorkspaceNotice message={notice} />
    </div>
  );
}
