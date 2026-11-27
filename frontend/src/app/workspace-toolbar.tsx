/**
 * @file 展示工作区路径、连接状态和常用操作。
 * @implementation 消费工作区传入的项目选择、会话导航及面板动作，提供工作空间管理、浏览器、终端和 Git 入口，并反馈选中、禁用和连接状态。
 * @updated 2026-11-26T17:15:12+08:00
 */
import { useId, type ReactNode, type Ref } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Ellipsis,
  FolderOpen,
  GitBranch,
  Globe,
  Menu,
  TerminalSquare,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useUiTranslation } from '@/i18n';

interface WorkspaceToolbarProps {
  projectName?: string;
  projectPath?: string;
  onOpenProjects?: () => void;
  sessionNavigation?: ReactNode;
  title: string;
  connected: boolean;
  canGoBack: boolean;
  onBack: () => void;
  onForward: () => void;
  onOpenNavigation: () => void;
  gitAction?: {
    open: boolean;
    busy: boolean;
    trigger: Ref<HTMLButtonElement>;
    onToggle: () => void;
  };
  sessionActions?: {
    browserOpen: boolean;
    browserTrigger: Ref<HTMLButtonElement>;
    onToggleBrowser: () => void;
    terminalOpen: boolean;
    terminalTrigger: Ref<HTMLButtonElement>;
    terminalDisabled: boolean;
    onToggleTerminal: () => void;
  };
}

export function WorkspaceToolbar({
  projectName,
  projectPath,
  onOpenProjects,
  sessionNavigation,
  title,
  connected,
  canGoBack,
  onBack,
  onForward,
  onOpenNavigation,
  gitAction,
  sessionActions,
}: WorkspaceToolbarProps) {
  const { t } = useUiTranslation('workbench');
  const { t: git } = useUiTranslation('git');
  const { t: terminal } = useUiTranslation('terminal');
  const { t: navigation } = useUiTranslation('navigation');
  const connectionStatusId = useId();
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <Button
          size="icon-sm"
          variant="ghost"
          className="react-chrome-action navigation"
          aria-label={t('navigation.open')}
          title={t('navigation.open')}
          onClick={onOpenNavigation}
        >
          <Menu aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="workspace-project-trigger"
          onClick={onOpenProjects}
          aria-label={navigation('sidebar.openWorkspaceSettings')}
          aria-description={projectPath ? `${projectName ?? ''} · ${projectPath}` : projectName}
          title={projectPath ?? projectName}
        >
          <FolderOpen data-icon="inline-start" aria-hidden="true" />
          <span className="truncate">{projectName ?? t('navigation.home')}</span>
        </Button>
        <span className="breadcrumb-slash" aria-hidden="true">
          /
        </span>
        <h1 className="truncate" title={title}>
          {title}
        </h1>
      </div>
      <div className="topbar-actions">
        {sessionNavigation}
        <span
          className="connection-state"
          data-connected={connected}
          tabIndex={0}
          aria-describedby={connectionStatusId}
        >
          <span className="connection-dot" aria-hidden="true" />
          <span className="connection-tooltip" id={connectionStatusId} role="status">
            {t(connected ? 'events.connectedTitle' : 'events.connectingTitle')}
          </span>
        </span>
        {gitAction ? (
          <Button
            ref={gitAction.trigger}
            size="icon-sm"
            variant={gitAction.open ? 'secondary' : 'ghost'}
            aria-label={git('title')}
            aria-pressed={gitAction.open}
            title={git('title')}
            disabled={gitAction.busy}
            onClick={gitAction.onToggle}
          >
            <GitBranch data-icon="inline-start" aria-hidden="true" />
          </Button>
        ) : null}
        {sessionActions ? (
          <>
            <Button
              ref={sessionActions.terminalTrigger}
              variant={sessionActions.terminalOpen ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={terminal('title')}
              title={terminal(sessionActions.terminalOpen ? 'hide' : 'open')}
              aria-pressed={sessionActions.terminalOpen}
              disabled={sessionActions.terminalDisabled}
              onClick={sessionActions.onToggleTerminal}
            >
              <TerminalSquare data-icon="inline-start" aria-hidden="true" />
            </Button>
            <Button
              ref={sessionActions.browserTrigger}
              variant={sessionActions.browserOpen ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={t('browser.title')}
              title={t(sessionActions.browserOpen ? 'browser.collapse' : 'browser.open')}
              aria-pressed={sessionActions.browserOpen}
              onClick={sessionActions.onToggleBrowser}
            >
              <Globe data-icon="inline-start" aria-hidden="true" />
            </Button>
          </>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('navigation.more')}
              title={t('navigation.more')}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!canGoBack} onSelect={onBack}>
                <ArrowLeft aria-hidden="true" />
                {t('navigation.back')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onForward}>
                <ArrowRight aria-hidden="true" />
                {t('navigation.forward')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
