/**
 * @file 编排工作区路由同步、启动恢复与页面导航动作。
 * @implementation 解析会话、项目草稿与视图路由，处理首发后路由替换、最近位置恢复和跨路由焦点清理。
 * @updated 2026-11-28T15:51:00+08:00
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  useCanGoBack,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import type { ExtensionSelection } from '@shared/types';
import { isWorkspaceLocation } from '@shared/workspace-location';
import type { Bootstrap } from '@/api/types';
import { useRememberWorkspaceLocation } from '@/use-query/settings/use-remember-workspace-location';
import { lastSession, rememberSession, seedSkillDraft } from './drafts';
import { panelLocation } from './panels/panel-location';
import { actions, useAppDispatch, type Tab, type View } from './store';
import type { SettingsSection } from './types';
import {
  collectionPaths,
  currentView,
  resolveInitialWorkspaceRoute,
  sessionTab,
  settingsPaths,
  settingsSection,
} from './workspace-state';

export function useWorkspaceNavigation({
  ready,
  onNoProjects,
}: {
  ready?: Bootstrap;
  onNoProjects: () => void;
}) {
  const dispatch = useAppDispatch();
  const location = useLocation();
  const pathname = location.pathname;
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const {
    sessionId,
    draftProjectId,
    runId: routeRunId,
    messageId: routeMessageId,
  } = useParams({
    strict: false,
  });
  const { routePanel, contentPath } = panelLocation(pathname, sessionId, location.state);
  const trace = routePanel ? contentPath.match(/\/trace\/([^/]+)$/u)?.[1] : routeRunId;
  const messageId = routePanel ? contentPath.match(/\/messages\/([^/]+)$/u)?.[1] : routeMessageId;
  const view = currentView(pathname);
  const tab = sessionTab(contentPath, sessionId);
  const section = settingsSection(pathname);

  const savedLocation = useRef<string | undefined>(undefined);
  const rememberLocation = useRememberWorkspaceLocation();
  const readyRef = useRef(ready);
  const onNoProjectsRef = useRef(onNoProjects);
  useLayoutEffect(() => {
    readyRef.current = ready;
    onNoProjectsRef.current = onNoProjects;
  });

  useEffect(() => {
    dispatch(
      actions.clearComposerFocus(
        tab === 'conversation' && sessionId ? { keepSessionId: sessionId } : undefined,
      ),
    );
  }, [dispatch, pathname, sessionId, tab]);

  useEffect(() => {
    function onRunFinished(event: Event) {
      const custom = event as CustomEvent<{ sessionId?: string; status?: string }>;
      const finishedSessionId = custom.detail?.sessionId;
      if (finishedSessionId && !sessionId && !draftProjectId) {
        void navigate({ to: `/sessions/${encodeURIComponent(finishedSessionId)}` });
      }
    }
    window.addEventListener('atelier:run-finished', onRunFinished);
    return () => {
      window.removeEventListener('atelier:run-finished', onRunFinished);
    };
  }, [draftProjectId, sessionId, navigate]);

  useEffect(() => {
    if (!ready || pathname !== '/') return;
    const resolved = resolveInitialWorkspaceRoute(ready, lastSession());
    if (resolved.kind === 'replace-raw') {
      router.history.replace(resolved.path);
      return;
    }
    if (resolved.kind === 'session') {
      void navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: resolved.sessionId },
        replace: true,
      });
    } else {
      void navigate({ to: '/sessions', replace: true });
    }
    if (resolved.openProjects) onNoProjectsRef.current();
  }, [navigate, pathname, ready, router.history]);

  useEffect(() => {
    if (!ready || pathname === savedLocation.current || !isWorkspaceLocation(pathname)) return;
    if (sessionId && !ready.sessions.some(({ id }) => id === sessionId)) return;
    if (sessionId) rememberSession(sessionId);
    savedLocation.current = pathname;
    rememberLocation(pathname);
  }, [pathname, ready, rememberLocation, sessionId]);

  const openSession = useCallback(
    (id?: string, runId?: string) => {
      dispatch(actions.setDrawer(undefined));
      if (!id) void navigate({ to: '/sessions' });
      else if (runId)
        void navigate({
          to: '/sessions/$sessionId/trace/$runId',
          params: { sessionId: id, runId },
        });
      else void navigate({ to: '/sessions/$sessionId', params: { sessionId: id } });
    },
    [dispatch, navigate],
  );

  const openDraft = useCallback(
    (projectId: string) => {
      dispatch(actions.setDrawer(undefined));
      if (router.state.location.pathname === `/drafts/${projectId}`) return Promise.resolve();
      return navigate({ to: '/drafts/$draftProjectId', params: { draftProjectId: projectId } });
    },
    [dispatch, navigate, router],
  );
  const startSkillDraft = useCallback(
    async (projectId: string, selection: ExtensionSelection, editable: boolean) => {
      seedSkillDraft(projectId, selection, editable);
      await openDraft(projectId);
    },
    [openDraft],
  );
  const replaceDraft = useCallback(
    (projectId: string, id: string) => {
      if (router.state.location.pathname !== `/drafts/${projectId}`) return Promise.resolve();
      return navigate({ to: '/sessions/$sessionId', params: { sessionId: id }, replace: true });
    },
    [navigate, router],
  );

  const openView = useCallback(
    (next: View) => {
      dispatch(actions.setDrawer(undefined));
      if (next === 'settings') {
        void navigate({ to: settingsPaths.models });
      } else if (next === 'chat') {
        if (view === 'chat' && (sessionId || draftProjectId)) return;
        const currentReady = readyRef.current;
        const saved = lastSession() ?? currentReady?.workspaceLastSession;
        openSession(
          currentReady?.sessions.find(({ id }) => id === saved)?.id ??
            currentReady?.sessions[0]?.id,
        );
      } else {
        void navigate({ to: collectionPaths[next] });
      }
    },
    [dispatch, draftProjectId, navigate, openSession, sessionId, view],
  );

  const openTrace = useCallback(
    (runId: string) => {
      if (sessionId) openSession(sessionId, runId);
    },
    [openSession, sessionId],
  );

  const selectTab = useCallback(
    (next: Tab) => {
      if (!sessionId) return;
      const params = { sessionId };
      if (next === 'trace') void navigate({ to: '/sessions/$sessionId/trace', params });
      else if (next === 'artifacts')
        void navigate({ to: '/sessions/$sessionId/artifacts', params });
      else if (tab !== 'conversation') void navigate({ to: '/sessions/$sessionId', params });
    },
    [navigate, sessionId, tab],
  );

  const openSettingsSection = useCallback(
    (next: SettingsSection) => {
      void navigate({ to: settingsPaths[next] });
    },
    [navigate],
  );

  const openMessage = useCallback(
    (targetSessionId: string, targetMessageId: string) => {
      void navigate({
        to: '/sessions/$sessionId/messages/$messageId',
        params: { sessionId: targetSessionId, messageId: targetMessageId },
      });
    },
    [navigate],
  );

  const navigateToConversation = useCallback(
    (targetSessionId: string) =>
      navigate({ to: '/sessions/$sessionId', params: { sessionId: targetSessionId } }),
    [navigate],
  );

  const getCurrentPath = useCallback(() => router.state.location.pathname, [router]);

  const currentContentPath = useCallback(
    (targetSessionId: string) => {
      const current = router.state.location;
      return panelLocation(current.pathname, targetSessionId, current.state).contentPath;
    },
    [router],
  );

  const goBack = useCallback(() => {
    router.history.back();
  }, [router.history]);

  const goForward = useCallback(() => {
    router.history.forward();
  }, [router.history]);

  return {
    pathname,
    sessionId,
    draftProjectId,
    routePanel,
    contentPath,
    trace,
    messageId,
    view,
    tab,
    section,
    canGoBack,
    openSession,
    openDraft,
    startSkillDraft,
    replaceDraft,
    openView,
    openTrace,
    selectTab,
    openSettingsSection,
    openMessage,
    navigateToConversation,
    getCurrentPath,
    currentContentPath,
    goBack,
    goForward,
  };
}
