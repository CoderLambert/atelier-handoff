/**
 * @file 装配工作区右侧面板槽位的具体内容视图。
 * @implementation 按优先级分发 Git 面板、定时任务受控面板、终端面板和浏览器面板。
 * @updated 2026-11-28T00:05:00+08:00
 */
import type { ReactNode } from 'react';
import type { Project, Session } from '@shared/types';
import type { GitPanelProps } from './git-panel';
import type { PanelViewProps } from '@/panel-sdk';
import { PanelHost } from './panel-host';
import { panels } from './registry';
import type { useWorkspacePanel } from './use-workspace-panel';

type PanelActions = Omit<PanelViewProps, 'instance' | 'visible'>;

export function WorkspaceRightPanel({
  panel,
  panelActions,
  projects,
  sessions,
  canQuoteGit,
  onQuoteGitCode,
  onOpenSession,
  onGitSessionCreated,
  terminalActive,
  terminalPanel,
  browserPanel,
}: {
  panel: ReturnType<typeof useWorkspacePanel>;
  panelActions: PanelActions;
  projects: readonly Project[];
  sessions: readonly Session[];
  canQuoteGit?: boolean;
  onQuoteGitCode?: GitPanelProps['board']['onQuoteCode'];
  onOpenSession: (sessionId: string) => void;
  onGitSessionCreated: (sessionId: string) => void;
  terminalActive: boolean;
  terminalPanel: ReactNode;
  browserPanel: ReactNode;
}) {
  if (panel.gitBoard) {
    const board = panel.gitBoard;
    return (
      <PanelHost
        definition={panels.git}
        view={{
          instance: board.instance,
          visible: true,
          ...panelActions,
          board: {
            project: board.project,
            initialTree: board.tree,
            initialTab: board.tab,
            busy: panel.gitBusy,
            onBusy: (busy) => panel.reportGitBusy(board.instance.instanceId, busy),
            onQuoteCode: canQuoteGit ? onQuoteGitCode : undefined,
            onCreated: onGitSessionCreated,
          },
        }}
      />
    );
  }
  if (panel.schedulePanel) {
    return (
      <PanelHost
        definition={panels.schedule}
        view={panel.buildScheduleView(panelActions, projects, sessions, onOpenSession)}
      />
    );
  }
  return terminalActive ? terminalPanel : browserPanel;
}
