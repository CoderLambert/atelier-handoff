/**
 * @file 编排工作区功能面板的身份、导航和焦点。
 * @implementation 管理 Git 与路由面板的打开、切换、收起、全屏和焦点；终端启动意图由显式操作产生。
 * @updated 2026-11-27T02:41:56+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
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
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const route = panelLocation(location.pathname, sessionId, location.state);
  const [gitBoard, setGitBoard] = useState<GitPanelRequest>();
  const [gitBusy, setGitBusy] = useState(false);
  const busyRef = useRef(false);
  const gitInstance = useRef<string | undefined>(undefined);
  const gitTrigger = useRef<HTMLButtonElement>(null);
  const browserTrigger = useRef<HTMLButtonElement>(null);
  const terminalTrigger = useRef<HTMLButtonElement>(null);
  const [terminalLaunch, setTerminalLaunch] = useState<TerminalLaunchIntent>();
  const [collapsedPanel, setCollapsedPanel] = useState<string>();
  const [expandedPanel, setExpandedPanel] = useState<string>();
  const capabilities = useTerminalCapabilities();
  useEffect(() => {
    if (capabilities.data) activateTerminalRuntime(capabilities.data.runtimeId);
  }, [capabilities.data?.runtimeId]);
  useEffect(() => {
    setTerminalLaunch(undefined);
  }, [sessionId]);
  const activePanel = gitBoard ? 'git' : route.routePanel;
  const panelKey = gitBoard?.instance.instanceId ?? (activePanel ? location.href : undefined);
  const rightCollapsed = panelKey !== undefined && collapsedPanel === panelKey;
  const canDock = width >= 1120;
  const fullWindow = Boolean(panelKey && (!canDock || expandedPanel === panelKey));
  const { expectedWorkspaceId, canCreate: terminalCanCreate } = terminalWorkspaceTarget(
    sessionId,
    snapshot,
  );

  function openGit(target: Project, tab?: 'files' | 'worktrees') {
    if (busyRef.current) return;
    setCollapsedPanel(undefined);
    if (gitBoard?.project.id === target.id && !tab) return;
    setExpandedPanel(undefined);
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
    });
  }
  function reportGitBusy(instanceId: string, busy: boolean) {
    if (gitInstance.current !== instanceId) return;
    busyRef.current = busy;
    setGitBusy(busy);
  }
  function clearGit() {
    gitInstance.current = undefined;
    busyRef.current = false;
    setGitBoard(undefined);
    setGitBusy(false);
    setExpandedPanel(undefined);
    setCollapsedPanel(undefined);
  }
  function openRoute(panel: RoutePanel) {
    if (!sessionId || busyRef.current) return;
    setCollapsedPanel(undefined);
    dispatch(actions.setDrawer(undefined));
    if (gitBoard) clearGit();
    if (route.routePanel === panel) return;
    setExpandedPanel(undefined);
    void navigate({
      to: panel === 'browser' ? '/sessions/$sessionId/browser' : '/sessions/$sessionId/terminal',
      params: { sessionId },
      replace: Boolean(route.routePanel),
      state: {
        workspacePanelReturn: route.contentPath,
      },
    });
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
  function collapseRight(restoreFocus = true) {
    if (busyRef.current || !panelKey) return;
    setCollapsedPanel(panelKey);
    if (restoreFocus)
      requestAnimationFrame(() => {
        const trigger =
          activePanel === 'git'
            ? gitTrigger
            : activePanel === 'terminal'
              ? terminalTrigger
              : browserTrigger;
        trigger.current?.focus({ preventScroll: true });
      });
  }
  function toggleRight() {
    if (busyRef.current || !panelKey) return;
    if (rightCollapsed) setCollapsedPanel(undefined);
    else collapseRight();
  }
  function toggleExpanded() {
    if (!canDock || !panelKey) return;
    setExpandedPanel((current) => (current === panelKey ? undefined : panelKey));
  }
  function dockRight() {
    setExpandedPanel(undefined);
  }
  return {
    activePanel,
    gitBoard,
    gitBusy,
    gitTrigger,
    openGit,
    clearGit,
    reportGitBusy,
    browserTrigger,
    openBrowser: () => openRoute('browser'),
    toggleBrowser: () => (activePanel === 'browser' ? toggleRight() : openRoute('browser')),
    terminalTrigger,
    terminalLaunch,
    toggleTerminal: () => (activePanel === 'terminal' ? toggleRight() : openTerminal()),
    openTerminal,
    rightCollapsed,
    fullWindow,
    canDock,
    toggleRight,
    collapseRight,
    toggleExpanded,
    dockRight,
    terminalCanCreate: Boolean(terminalCanCreate),
    expectedWorkspaceId,
    terminalLoading: capabilities.isPending || snapshot?.session.id !== sessionId,
  };
}
