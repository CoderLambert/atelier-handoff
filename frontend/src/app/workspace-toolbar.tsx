/**
 * @file 展示工作区路径、连接状态和常用操作。
 * @implementation 使用工作区传入的导航与面板动作，保持浏览器触发点并在稳定的状态标记上应用局部反馈。
 * @updated 2026-11-23T04:49:37+08:00
 */
import type { Ref } from 'react';
import { ArrowLeft, ArrowRight, FileDiff, Globe, Menu, Settings2 } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import * as m from 'motion/react-m';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { feedbackTransition } from './workspace-notice';

interface WorkspaceToolbarProps {
  projectName?: string;
  title: string;
  connected: boolean;
  canGoBack: boolean;
  onBack: () => void;
  onForward: () => void;
  onOpenNavigation: () => void;
  onOpenSettings: () => void;
  sessionActions?: {
    pendingPermissions: number;
    browserOpen: boolean;
    browserTrigger: Ref<HTMLButtonElement>;
    onOpenChanges: () => void;
    onToggleBrowser: () => void;
  };
}

export function WorkspaceToolbar({
  projectName,
  title,
  connected,
  canGoBack,
  onBack,
  onForward,
  onOpenNavigation,
  onOpenSettings,
  sessionActions,
}: WorkspaceToolbarProps) {
  const { t } = useUiTranslation('workbench');
  const reduceMotion = useReducedMotion();
  const changesLabel = sessionActions?.pendingPermissions
    ? t('changes.pending', { count: sessionActions.pendingPermissions })
    : t('changes.title');

  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <Button
          size="icon-sm"
          variant="ghost"
          className="react-chrome-action navigation"
          aria-label={t('navigation.open')}
          onClick={onOpenNavigation}
        >
          <Menu aria-hidden="true" />
        </Button>
        <span className="truncate" title={projectName}>
          {projectName ?? t('navigation.home')}
        </span>
        <span className="breadcrumb-slash" aria-hidden="true">
          /
        </span>
        <span className="truncate" title={title}>
          {title}
        </span>
      </div>
      <div className="topbar-actions">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('navigation.back')}
          disabled={!canGoBack}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('navigation.forward')}
          onClick={onForward}
        >
          <ArrowRight aria-hidden="true" />
        </Button>
        <span
          className="connection-state"
          data-connected={connected}
          role="status"
          title={connected ? t('events.connectedTitle') : t('events.connectingTitle')}
        >
          <m.span
            aria-hidden="true"
            className="connection-dot"
            initial={false}
            animate={{ opacity: connected ? 1 : 0.55 }}
            transition={reduceMotion ? { duration: 0 } : feedbackTransition}
          />
          {connected ? t('events.connected') : t('events.connecting')}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('settings.models')}
          onClick={onOpenSettings}
        >
          <Settings2 aria-hidden="true" />
        </Button>
        {sessionActions ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="topbar-changes-btn"
              data-pending={sessionActions.pendingPermissions > 0 || undefined}
              aria-label={t('changes.title')}
              title={changesLabel}
              onClick={sessionActions.onOpenChanges}
            >
              <FileDiff data-icon="inline-start" aria-hidden="true" />
              <span className="workspace-action-label">{changesLabel}</span>
            </Button>
            <Button
              ref={sessionActions.browserTrigger}
              variant={sessionActions.browserOpen ? 'secondary' : 'ghost'}
              size="sm"
              aria-label={t('browser.title')}
              title={t(sessionActions.browserOpen ? 'browser.close' : 'browser.open')}
              aria-pressed={sessionActions.browserOpen}
              onClick={sessionActions.onToggleBrowser}
            >
              <Globe data-icon="inline-start" aria-hidden="true" />
              <span className="workspace-action-label">{t('browser.title')}</span>
            </Button>
          </>
        ) : null}
      </div>
    </header>
  );
}
