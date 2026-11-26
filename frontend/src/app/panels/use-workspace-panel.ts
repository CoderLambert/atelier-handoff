/**
 * @file 编排工作区功能面板的身份、导航和焦点。
 * @implementation 管理 Git 与路由面板的打开、关闭和独立尺寸；折叠右栏时保留面板状态并按需交还焦点，终端启动意图由显式操作产生。
 * @updated 2026-11-26T21:58:23+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { useCanGoBack, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import type { Project } from '@shared/types';
import type { Snapshot } from '@/api/types';
import type { PanelInstance, ProjectPanelTarget } from '@/panel-sdk';
import type { TerminalLaunchIntent } from '@/features/terminal';
import { activateTerminalRuntime } from '@/features/terminal/terminal-client';
import { useTerminalCapabilities } from '@/use-query/terminal/use-terminal-capabilities';
import { actions, useAppDispatch } from '../store';
import { panelLocation, type RoutePanel } from './panel-location';
import { terminalWorkspaceTarget } from './terminal-target';

interface GitPanelRequest {
  instance: PanelInstance<'atelier.git', ProjectPanelTarget>;
  project: Project;
  tree?: string;
  tab?: 'files' | 'worktrees';
  trigger: HTMLElement | null;
}
export function useWorkspacePanel({
  sessionId,
  snapshot,
  width,
}: {
  sessionId?: string;
  snapshot?: Snapshot;
  width: number;
}) {
  const location = useLocation();
  const router = useRouter();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const canGoBack = useCanGoBack();
  const route = panelLocation(location.pathname, sessionId, location.state);
  const [gitBoard, setGitBoard] = useState<GitPanelRequest>();
  const [gitExpanded, expandGit] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  const busyRef = useRef(false);
  const gitInstance = useRef<string | undefined>(undefined);
  const [gitWidth, setGitWidth] = useState<number>();
  const gitTrigger = useRef<HTMLButtonElement>(null);
  const browserTrigger = useRef<HTMLButtonElement>(null);
  const terminalTrigger = useRef<HTMLButtonElement>(null);
  const [terminalWidth, setTerminalWidth] = useState(640);
  const [terminalExpanded, expandTerminal] = useState(false);
  const [terminalLaunch, setTerminalLaunch] = useState<TerminalLaunchIntent>();
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const capabilities = useTerminalCapabilities();
  useEffect(() => {
    if (capabilities.data) activateTerminalRuntime(capabilities.data.runtimeId);
  }, [capabilities.data?.runtimeId]);
  useEffect(() => {
    setTerminalLaunch(undefined);
    expandTerminal(false);
  }, [sessionId]);
  const canDockGit = width >= 1120;
  const gitFullWindow = Boolean(gitBoard && (gitExpanded || !canDockGit));
  const terminalActive = route.routePanel === 'terminal' && !gitBoard;
  const terminalFullWindow = terminalActive && (terminalExpanded || !canDockGit);
  const browserActive = route.routePanel === 'browser' && !gitBoard;
  const { expectedWorkspaceId, canCreate: terminalCanCreate } = terminalWorkspaceTarget(
    sessionId,
    snapshot,
  );

  function openGit(target: Project, tab?: 'files' | 'worktrees') {
    if (busyRef.current) return;
    setRightCollapsed(false);
    if (gitBoard?.project.id === target.id && !tab) return;
    const instanceId = crypto.randomUUID();
    gitInstance.current = instanceId;
    setGitBoard({
      instance: {
        instanceId,
        panelId: 'atelier.git',
        target: { scope: 'project', projectId: target.id },
      },
      project: target,
      tab,
      tree:
        snapshot?.project.id === target.id && snapshot.workspace?.mode === 'linked'
          ? snapshot.workspace.id
          : undefined,
      trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }
  function reportGitBusy(instanceId: string, busy: boolean) {
    if (gitInstance.current !== instanceId) return;
    busyRef.current = busy;
    setGitBusy(busy);
  }
  function closeGit(restoreFocus = true, completed = false) {
    if (busyRef.current && !completed) return;
    const trigger = gitBoard?.trigger;
    gitInstance.current = undefined;
    busyRef.current = false;
    setGitBoard(undefined);
    expandGit(false);
    setGitBusy(false);
    if (restoreFocus)
      requestAnimationFrame(() => {
        const target =
          trigger?.isConnected && trigger !== document.body ? trigger : gitTrigger.current;
        target?.focus({ preventScroll: true });
      });
  }
  function openRoute(panel: RoutePanel) {
    if (!sessionId || busyRef.current) return;
    setRightCollapsed(false);
    dispatch(actions.setDrawer(undefined));
    if (gitBoard) closeGit(false);
    if (route.routePanel === panel) return;
    void navigate({
      to: panel === 'browser' ? '/sessions/$sessionId/browser' : '/sessions/$sessionId/terminal',
      params: { sessionId },
      replace: Boolean(route.routePanel),
      state: {
        workspacePanelReturn: route.contentPath,
        workspacePanelReturnIndex: route.routePanel
          ? location.state.workspacePanelReturnIndex
          : location.state.__TSR_index,
      },
    });
  }
  function closeRoute(panel: RoutePanel) {
    if (!sessionId || route.routePanel !== panel || busyRef.current) return;
    setTerminalLaunch(undefined);
    expandTerminal(false);
    if (route.canReturnBack && canGoBack) router.history.back();
    else
      void navigate({
        to: route.returnPath ?? `/sessions/${encodeURIComponent(sessionId)}`,
        replace: true,
      });
    requestAnimationFrame(() =>
      (panel === 'browser' ? browserTrigger : terminalTrigger).current?.focus({
        preventScroll: true,
      }),
    );
  }
  function toggleBrowser() {
    if (browserActive && !rightCollapsed) closeRoute('browser');
    else openRoute('browser');
  }
  function openTerminal() {
    if (busyRef.current) return;
    if (
      route.routePanel !== 'terminal' &&
      capabilities.data?.supported &&
      snapshot &&
      sessionId &&
      terminalCanCreate
    ) {
      setTerminalLaunch({
        terminalId: crypto.randomUUID(),
        runtimeId: capabilities.data.runtimeId,
        sessionId,
        projectId: snapshot.project.id,
        expectedWorkspaceId,
      });
    }
    openRoute('terminal');
  }
  function toggleTerminal() {
    if (terminalActive && !rightCollapsed) closeRoute('terminal');
    else openTerminal();
  }
  function collapseRight(restoreFocus = true) {
    if (busyRef.current) return;
    const returnFocus = document.activeElement?.closest(
      '.git-board, .terminal-panel, .desktop-browser',
    );
    setRightCollapsed(true);
    if (restoreFocus && returnFocus)
      requestAnimationFrame(() => {
        const trigger = gitBoard ? gitTrigger : terminalActive ? terminalTrigger : browserTrigger;
        trigger.current?.focus({ preventScroll: true });
      });
  }
  return {
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
    reportGitBusy,
    browserActive,
    browserTrigger,
    openBrowser: () => openRoute('browser'),
    closeBrowser: () => closeRoute('browser'),
    toggleBrowser,
    terminalActive,
    terminalTrigger,
    terminalWidth,
    setTerminalWidth,
    terminalFullWindow,
    expandTerminal,
    terminalLaunch,
    rightCollapsed,
    hasRightPanel: Boolean(gitBoard || route.routePanel),
    toggleRight: () => {
      if (busyRef.current || (!gitBoard && !route.routePanel)) return;
      if (rightCollapsed) setRightCollapsed(false);
      else collapseRight();
    },
    collapseRight,
    openTerminal,
    toggleTerminal,
    closeTerminal: () => closeRoute('terminal'),
    terminalCanCreate: Boolean(terminalCanCreate),
    expectedWorkspaceId,
    terminalLoading: capabilities.isPending || snapshot?.session.id !== sessionId,
  };
}
