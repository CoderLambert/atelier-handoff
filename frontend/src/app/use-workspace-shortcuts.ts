/**
 * @file 组装工作台全局快捷键命令列表。
 * @implementation 将布局切换、会话导航、右侧工具面板与输入框聚焦等快捷键动作从 Workspace 外壳解耦。
 * @updated 2026-11-27T12:48:00-06:00
 */
import type { Project, Session } from '@shared/types';
import type { WorkspaceLayout } from '@shared/workspace-layout';
import { useShortcutCommandLabels, type ShortcutCommand } from '@/features/shortcuts';
import { adjacentSessionId } from './session-switcher-model';

export interface WorkspaceShortcutsInput {
  sessions: readonly Session[];
  sessionId?: string;
  project?: Project;
  hasSnapshot: boolean;
  showLeft: boolean;
  layout: WorkspaceLayout;
  drawer?: 'navigation' | 'details';
  activePanel?: string;
  fullWindow: boolean;
  gitBusy: boolean;
  terminalLoading: boolean;
  canFocusComposer: boolean;
  changeLayout: (next: WorkspaceLayout) => void;
  closeDrawer: () => void;
  openDrawer: (next: 'navigation' | 'details') => void;
  toggleRight: () => void;
  collapseRight: (focus?: boolean) => void;
  openSwitcher: () => void;
  openShortcutSession: (id: string) => void;
  openGit: (project: Project) => void;
  openTerminal: () => void;
  openBrowser: () => void;
  focusComposer: () => void;
  openShortcutSettings: () => void;
}

export function useWorkspaceShortcuts(input: WorkspaceShortcutsInput): ShortcutCommand[] {
  const shortcutLabels = useShortcutCommandLabels();
  const previousSession = adjacentSessionId(input.sessions, input.sessionId, -1);
  const nextSession = adjacentSessionId(input.sessions, input.sessionId, 1);

  const shortcutActions: {
    id: keyof typeof shortcutLabels;
    available: boolean;
    run: () => void;
  }[] = [
    {
      id: 'layout.toggleLeft',
      available: true,
      run: () =>
        input.showLeft
          ? input.changeLayout({ ...input.layout, collapsed: !input.layout.collapsed })
          : input.drawer === 'navigation'
            ? input.closeDrawer()
            : input.openDrawer('navigation'),
    },
    {
      id: 'layout.toggleRight',
      available: Boolean(input.activePanel) && !input.gitBusy,
      run: input.toggleRight,
    },
    { id: 'sessions.switch', available: !input.gitBusy, run: input.openSwitcher },
    {
      id: 'sessions.previous',
      available: Boolean(previousSession) && !input.gitBusy,
      run: () => {
        if (previousSession) input.openShortcutSession(previousSession);
      },
    },
    {
      id: 'sessions.next',
      available: Boolean(nextSession) && !input.gitBusy,
      run: () => {
        if (nextSession) input.openShortcutSession(nextSession);
      },
    },
    {
      id: 'panels.git',
      available: Boolean(input.project?.available) && !input.gitBusy,
      run: () => {
        if (input.project) input.openGit(input.project);
      },
    },
    {
      id: 'panels.terminal',
      available:
        Boolean(input.sessionId && input.hasSnapshot) && !input.gitBusy && !input.terminalLoading,
      run: input.openTerminal,
    },
    {
      id: 'panels.browser',
      available: Boolean(input.sessionId && input.project?.available) && !input.gitBusy,
      run: input.openBrowser,
    },
    {
      id: 'composer.focus',
      available: input.canFocusComposer,
      run: input.focusComposer,
    },
    {
      id: 'shortcuts.settings',
      available: !input.gitBusy,
      run: () => {
        if (input.fullWindow) input.collapseRight(false);
        input.openShortcutSettings();
      },
    },
  ];

  return shortcutActions.flatMap((action) => {
    const label = shortcutLabels[action.id];
    return label ? [{ ...label, ...action }] : [];
  });
}
