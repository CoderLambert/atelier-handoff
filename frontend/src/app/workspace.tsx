/**
 * @file 编排工作区、会话及各功能页面。
 * @implementation 组合会话查询、操作、布局与按需加载的功能组件。
 * @updated 2026-11-20T02:00+08:00
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Menu, PanelRight, Settings2 } from 'lucide-react';
import type { Run, Session } from '@shared/types';
import { api, bootstrap } from '@/api/client';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
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
import { DesktopBrowser, useDesktopBrowser } from './desktop-browser';
import { actions, type Tab, useAppDispatch, useWorkspace, type View } from './store';

const SessionChat = lazy(() => import('./session-chat'));
const ExtensionsPage = lazy(() => import('@/features/extensions'));
const AgentsPage = lazy(() => import('@/features/agents'));
const Inspector = lazy(() =>
  import('@/features/inspector').then(({ Inspector }) => ({ default: Inspector })),
);
const RunTrace = lazy(() =>
  import('@/features/inspector').then(({ RunTrace }) => ({ default: RunTrace })),
);
const Collections = lazy(() =>
  import('@/features/inspector').then(({ Collections }) => ({ default: Collections })),
);
const Settings = lazy(() =>
  import('@/features/inspector').then(({ Settings }) => ({ default: Settings })),
);
const tabs = [
  { id: 'conversation', label: '会话' },
  { id: 'trace', label: '执行轨迹' },
  { id: 'artifacts', label: '交付物' },
] as const;
const active = new Set(['queued', 'running', 'awaiting_permission', 'stopping']);
const loading = (
  <p className="empty-text px-5 py-4" role="status">
    加载中…
  </p>
);

type SessionAction = 'rename' | 'archive' | 'delete';
const sessionActions = { rename: '重命名会话', archive: '归档会话', delete: '删除会话' };

export default function Workspace() {
  const dispatch = useAppDispatch();
  const client = useQueryClient();
  const sessionId = useWorkspace((state) => state.workspace.sessionId);
  const view = useWorkspace((state) => state.workspace.view);
  const tab = useWorkspace((state) => state.workspace.tab);
  const trace = useWorkspace((state) => state.workspace.traceRunId);
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
  const [sideTab, setSideTab] = useState<'details' | 'browser'>('details');
  const previewProject = view === 'chat' ? project?.id : undefined;
  const desktop = Boolean(window.atelierDesktop);
  const nativeBrowser = useDesktopBrowser(desktop ? previewProject : undefined);
  const browser = useBrowserPreview(desktop ? undefined : previewProject, sideTab === 'browser');
  const previewUrl = desktop ? nativeBrowser?.url : browser.data?.frame?.url;
  const firstPreview = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previewProject && previewUrl && firstPreview.current !== previewProject) {
      firstPreview.current = previewProject;
      setSideTab('browser');
    }
  }, [previewProject, previewUrl]);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionChange, setSessionChange] = useState<{ type: SessionAction; session: Session }>();
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState('');
  const didRestore = useRef(false);
  const retryKeys = useRef(new Map<string, string>());
  useRunEvents(client, ready.data?.cursor);

  useEffect(() => {
    if (!ready.data || didRestore.current) return;
    didRestore.current = true;
    const saved = lastSession();
    const restored =
      ready.data.sessions.find((item) => item.id === saved) ??
      ready.data.sessions.find((item) => item.status === 'active') ??
      ready.data.sessions[0];
    if (restored) dispatch(actions.openSession({ id: restored.id }));
    if (!ready.data.projects.length) setProjectsOpen(true);
  }, [dispatch, ready.data]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  function openSession(id?: string, runId?: string) {
    rememberSession(id);
    dispatch(actions.openSession({ id, runId }));
  }
  function openView(next: View) {
    dispatch(actions.openView(next));
  }
  function openTrace(runId: string) {
    dispatch(actions.showTrace(runId));
  }
  function selectTab(next: Tab) {
    dispatch(actions.setTab(next));
  }
  async function revalidate(id: string) {
    void client.invalidateQueries({ queryKey: keys.sessions });
    void client.invalidateQueries({ queryKey: keys.runs });
    await client.invalidateQueries({ queryKey: keys.snapshot(id) });
  }
  const createSession = useMutation({
    mutationFn: (projectId: string) =>
      api<{ session: Session }>('/api/sessions', { method: 'POST', body: { projectId } }),
    onSuccess({ session }) {
      openSession(session.id);
      void client.invalidateQueries({ queryKey: keys.bootstrap });
      void client.invalidateQueries({ queryKey: keys.sessions });
    },
  });
  const action = useMutation({
    mutationFn: async (data: { type: SessionAction; session: Session; title: string }) => {
      const { type, session, title } = data;
      const path = `/api/sessions/${encodeURIComponent(session.id)}`;
      if (type === 'delete') return deleteDraft(session.id, () => api(path, { method: 'DELETE' }));
      return api(path, {
        method: 'PATCH',
        body:
          type === 'rename'
            ? { title: title.trim() }
            : { status: session.status === 'active' ? 'archived' : 'active' },
      });
    },
    onSuccess: async (_, data) => {
      setSessionChange(undefined);
      if (data.type === 'delete' && sessionId === data.session.id) {
        openSession(ready.data?.sessions.find((item) => item.id !== data.session.id)?.id);
        client.removeQueries({ queryKey: keys.snapshot(data.session.id) });
      }
      await Promise.all([
        revalidate(data.session.id),
        client.invalidateQueries({ queryKey: keys.bootstrap }),
      ]);
    },
    onError: (error) => setNotice(error.message),
  });
  const runAction = useMutation({
    mutationFn: async ({
      id,
      intent,
    }: {
      id: string;
      intent: 'stop' | 'retry';
      sessionId: string;
    }) => {
      let key = retryKeys.current.get(id);
      if (intent === 'retry' && !key) {
        key = crypto.randomUUID();
        retryKeys.current.set(id, key);
      }
      await api(`/api/runs/${encodeURIComponent(id)}/${intent}`, {
        method: 'POST',
        body: intent === 'retry' ? { idempotencyKey: key } : {},
      });
      if (intent === 'retry') retryKeys.current.delete(id);
    },
    onSuccess: (_, variables) => revalidate(variables.sessionId),
    onError: (error) => setNotice(error.message),
  });
  const upgradeAgent = useMutation({
    mutationFn: (input: { sessionId: string; revisionId: string }) =>
      api(`/api/sessions/${encodeURIComponent(input.sessionId)}/upgrade-agent`, {
        method: 'POST',
        body: { revisionId: input.revisionId },
      }),
    onSuccess: (_, input) => revalidate(input.sessionId),
    onError: (error) => setNotice(error.message),
  });
  function openSessionAction(type: SessionAction) {
    if (!snapshot) return;
    setSessionChange({ type, session: snapshot.session });
    setTitle(snapshot.session.title);
  }
  const sideProps = {
    project,
    artifactCount: ready.data?.artifacts.length,
    onSession: openSession,
    onView: openView,
    onNew: () =>
      project?.available
        ? createSession.mutate(project.id, { onError: (error) => setNotice(error.message) })
        : setProjectsOpen(true),
    onProjects: () => {
      dispatch(actions.setDrawer(undefined));
      setProjectsOpen(true);
    },
    onSettings: () => {
      dispatch(actions.setDrawer(undefined));
      setSettingsOpen(true);
    },
  };
  const inspector = (
    <Inspector
      snapshot={snapshot}
      run={selectedRun}
      onTrace={openTrace}
      onSessionAction={openSessionAction}
    />
  );
  const sidePanel = (
    <>
      <div className="workspace-side-tabs" role="group" aria-label="右侧面板">
        <Button
          size="sm"
          variant={sideTab === 'details' ? 'secondary' : 'ghost'}
          aria-pressed={sideTab === 'details'}
          onClick={() => setSideTab('details')}
        >
          任务详情
        </Button>
        <Button
          size="sm"
          variant={sideTab === 'browser' ? 'secondary' : 'ghost'}
          aria-pressed={sideTab === 'browser'}
          onClick={() => setSideTab('browser')}
        >
          浏览器
        </Button>
      </div>
      {sideTab === 'browser' ? (
        desktop && previewProject ? (
          <DesktopBrowser key={previewProject} projectId={previewProject} state={nativeBrowser} />
        ) : (
          <BrowserPreview frame={browser.data?.frame} error={browser.isError} />
        )
      ) : (
        inspector
      )}
    </>
  );
  const archiveLabel =
    sessionChange?.type === 'archive' && sessionChange.session.status === 'archived'
      ? '恢复会话'
      : sessionChange
        ? sessionActions[sessionChange.type]
        : '';
  return (
    <div
      className={`app react-workspace${desktop ? ' desktop-workspace' : ''}${sideTab === 'browser' ? ' browser-preview-open' : ''}`}
    >
      <Sidebar {...sideProps} />
      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs">
            <Button
              size="icon"
              variant="ghost"
              className="react-chrome-action navigation"
              aria-label="打开导航"
              onClick={() => dispatch(actions.setDrawer('navigation'))}
            >
              <Menu size={17} />
            </Button>
            <span className="od-truncate">{project?.name ?? '本地工作台'}</span>
            <span className="breadcrumb-slash">/</span>
            <span className="od-truncate">
              {view === 'chat'
                ? (snapshot?.session.title ?? '会话')
                : view === 'runs'
                  ? '执行记录'
                  : view === 'artifacts'
                    ? '交付物'
                    : view === 'agents'
                      ? '智能体'
                      : '扩展'}
            </span>
          </div>
          <div className="topbar-actions">
            <span
              className="connection-state"
              title={connected ? '实时事件已连接' : '正在连接实时事件'}
            >
              {connected ? '事件流已连接' : '事件流重连中'}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="模型与网关设置"
              onClick={sideProps.onSettings}
            >
              <Settings2 size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="react-chrome-action details"
              aria-label="任务详情"
              onClick={() => dispatch(actions.setDrawer('details'))}
            >
              <PanelRight size={16} />
            </Button>
          </div>
        </header>
        <div className="react-center">
          {ready.isError ? (
            <div className="px-5 py-4" role="alert">
              <p>无法连接本地服务。{ready.error.message}</p>
              <Button variant="secondary" onClick={() => void ready.refetch()}>
                重试
              </Button>
            </div>
          ) : null}
          <Suspense fallback={loading}>
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
                    const { session } = await api<{ session: Session }>('/api/sessions', {
                      method: 'POST',
                      body: { projectId },
                    });
                    await api(`/api/sessions/${encodeURIComponent(session.id)}`, {
                      method: 'PATCH',
                      body: {
                        draft: {
                          ...session.draft,
                          extensionSelections: [selection],
                          mode: editable ? 'edit' : 'readonly',
                        },
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
              <section className="conversation-screen" aria-label="会话工作区">
                <header className="session-header">
                  <div className="session-title-row">
                    <h1>{snapshot?.session.title ?? '开始工作'}</h1>
                    {snapshot?.agent?.canUpgrade ? (
                      <Button
                        size="sm"
                        disabled={upgradeAgent.isPending}
                        onClick={() =>
                          upgradeAgent.mutate({
                            sessionId: snapshot.session.id,
                            revisionId: snapshot.agent!.revisionId,
                          })
                        }
                      >
                        在此会话使用新版
                      </Button>
                    ) : null}
                    {snapshot?.agent ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openView('agents')}
                        title="打开智能体管理"
                      >
                        {snapshot.agent.name} · v{snapshot.agent.version}
                      </Button>
                    ) : null}
                  </div>
                  {project ? (
                    <p className="session-meta">
                      {project.branch || '本地目录'} <span>·</span> 本地工作空间
                    </p>
                  ) : null}
                </header>
                <div role="tablist" className="session-tabs" aria-label="会话内容">
                  {tabs.map(({ id, label }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      className={`session-tab ${tab === id ? 'active' : ''}`}
                      aria-selected={tab === id}
                      onClick={() => selectTab(id)}
                    >
                      {label}
                      {id === 'trace' && snapshot?.tools.length ? ` ${snapshot.tools.length}` : ''}
                      {id === 'artifacts' && snapshot?.artifacts.length
                        ? ` ${snapshot.artifacts.length}`
                        : ''}
                    </button>
                  ))}
                </div>
                <div
                  className="react-conversation-body"
                  role="tabpanel"
                  aria-label={tabs.find((item) => item.id === tab)?.label}
                >
                  {snapshot && tab === 'conversation' ? (
                    <SessionChat
                      key={snapshot.session.id}
                      snapshot={snapshot}
                      defaultModel={ready.data?.config.model ?? ''}
                      onOpenLink={
                        desktop
                          ? async (url, destination) => {
                              const bridge = window.atelierDesktop;
                              if (!bridge) throw new Error('桌面浏览器当前不可用。');
                              if (destination === 'internal') setSideTab('browser');
                              await bridge.command(
                                snapshot.project.id,
                                destination === 'internal' ? 'open-tab' : 'open-external',
                                url,
                              );
                            }
                          : undefined
                      }
                      onSent={revalidate}
                      onError={setNotice}
                      onStop={(id) =>
                        runAction.mutate({ id, intent: 'stop', sessionId: snapshot.session.id })
                      }
                      onRetry={(id) =>
                        runAction.mutate({ id, intent: 'retry', sessionId: snapshot.session.id })
                      }
                      onTrace={openTrace}
                    />
                  ) : null}
                  {snapshot && tab === 'trace' ? (
                    <div className="react-scroll-view">
                      <RunTrace snapshot={snapshot} runId={selectedRun?.id} onSelect={openTrace} />
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
                        <p>{session.error.message}</p>
                        <Button variant="secondary" onClick={() => void session.refetch()}>
                          重试
                        </Button>
                      </div>
                    ) : sessionId || ready.isPending ? (
                      loading
                    ) : (
                      <div className="welcome">
                        <h2>开始你的工作</h2>
                        <p>绑定本机项目目录，然后新建会话。</p>
                        <Button onClick={sideProps.onProjects}>绑定项目</Button>
                      </div>
                    )
                  ) : null}
                </div>
              </section>
            ) : null}
          </Suspense>
        </div>
      </main>
      {drawer !== 'details' ? (
        <aside className="react-side" aria-label="任务详情">
          <Suspense fallback={loading}>{sidePanel}</Suspense>
        </aside>
      ) : (
        <aside className="react-side" />
      )}
      <Dialog
        open={!!drawer}
        onOpenChange={(open) => {
          if (!open) dispatch(actions.setDrawer(undefined));
        }}
      >
        <DialogContent
          className={`react-drawer ${drawer === 'details' ? 'react-drawer-details' : ''}`}
        >
          <DialogTitle className="sr-only">
            {drawer === 'details' ? '任务详情' : '工作空间导航'}
          </DialogTitle>
          <DialogDescription className="sr-only">本地工作台</DialogDescription>
          {drawer === 'navigation' ? <Sidebar {...sideProps} /> : null}
          {drawer === 'details' ? <Suspense fallback={loading}>{sidePanel}</Suspense> : null}
        </DialogContent>
      </Dialog>
      {projectsOpen ? (
        <ProjectsDialog
          open
          onOpenChange={setProjectsOpen}
          projects={ready.data?.projects ?? []}
          onChoose={async (id) => {
            await createSession.mutateAsync(id);
          }}
        />
      ) : null}
      {settingsOpen ? (
        <Suspense fallback={null}>
          <Settings open onOpenChange={setSettingsOpen} />
        </Suspense>
      ) : null}
      <Dialog
        open={!!sessionChange}
        onOpenChange={(open) => {
          if (!open && !action.isPending) setSessionChange(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{archiveLabel}</DialogTitle>
            <DialogDescription>{sessionChange?.session.title}</DialogDescription>
          </DialogHeader>
          {sessionChange?.type === 'rename' ? (
            <label className="grid gap-2">
              会话名称
              <input
                className="field"
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          ) : null}
          {sessionChange?.type === 'delete' ? (
            <p className="text-sm">删除后将移除该会话的历史及工作台记录。</p>
          ) : null}
          <div className="dialog-actions">
            <Button
              variant="secondary"
              disabled={action.isPending}
              onClick={() => setSessionChange(undefined)}
            >
              取消
            </Button>
            <Button
              variant={sessionChange?.type === 'delete' ? 'destructive' : 'default'}
              disabled={action.isPending || (sessionChange?.type === 'rename' && !title.trim())}
              onClick={() => {
                if (sessionChange) action.mutate({ ...sessionChange, title });
              }}
            >
              {archiveLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {notice ? (
        <div className="toast" role="status">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
