/**
 * @file 组合工作台的弹窗、抽屉、会话切换器与提示条。
 * @implementation 集中渲染导航/变更抽屉、项目选择器、会话管理弹窗与全局通知条，减轻 Workspace 主组件体积。
 * @updated 2026-11-27T12:48:00-06:00
 */
import { lazy, Suspense, type ComponentProps, type MutableRefObject, type ReactNode } from 'react';
import type { Project, Session } from '@shared/types';
import type { Snapshot } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { translateError, useUiTranslation } from '@/i18n';
import { ProjectsDialog } from './projects';
import {
  SessionManagementController,
  type SessionActionRequest,
} from './session-management-controller';
import { Sidebar } from './sidebar';
import { WorkspaceNotice } from './workspace-notice';
import { WorkspaceSessionSwitcher } from './workspace-session-switcher';

const SessionChanges = lazy(() =>
  import('@/features/inspector').then(({ SessionChanges }) => ({ default: SessionChanges })),
);

export interface WorkspaceOverlaysProps {
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
  projectsOpen: boolean;
  onProjectsOpenChange: (open: boolean) => void;
  drawer?: 'navigation' | 'details';
  drawerTrigger: MutableRefObject<HTMLElement | null>;
  onCloseDrawer: () => void;
  sessions: readonly Session[];
  projects: readonly Project[];
  currentSessionId?: string;
  bootstrapLoading: boolean;
  bootstrapFailed: boolean;
  onRetryBootstrap: () => void;
  onSelectShortcutSession: (id: string) => void;
  sideProps: ComponentProps<typeof Sidebar>;
  snapshot?: Snapshot;
  sessionError: unknown;
  sessionFailed: boolean;
  onRetrySession: () => void;
  loading: ReactNode;
  onCreateProjectSession: (id: string) => Promise<void>;
  onOpenGit: (project: Project) => void;
  sessionAction?: SessionActionRequest;
  getCurrentPath: () => string;
  onOpenSession: (id?: string) => void;
  onCloseSessionAction: () => void;
  notice: string;
}

export function WorkspaceOverlays({
  switcherOpen,
  onSwitcherOpenChange,
  projectsOpen,
  onProjectsOpenChange,
  drawer,
  drawerTrigger,
  onCloseDrawer,
  sessions,
  projects,
  currentSessionId,
  bootstrapLoading,
  bootstrapFailed,
  onRetryBootstrap,
  onSelectShortcutSession,
  sideProps,
  snapshot,
  sessionError,
  sessionFailed,
  onRetrySession,
  loading,
  onCreateProjectSession,
  onOpenGit,
  sessionAction,
  getCurrentPath,
  onOpenSession,
  onCloseSessionAction,
  notice,
}: WorkspaceOverlaysProps) {
  const { t } = useUiTranslation('workbench');

  return (
    <>
      <WorkspaceSessionSwitcher
        open={switcherOpen}
        onOpenChange={onSwitcherOpenChange}
        sessions={[...sessions]}
        projects={[...projects]}
        current={currentSessionId}
        loading={bootstrapLoading}
        failed={bootstrapFailed}
        onRetry={onRetryBootstrap}
        onSelect={onSelectShortcutSession}
      />
      <Dialog
        open={Boolean(drawer)}
        onOpenChange={(open) => {
          if (!open) onCloseDrawer();
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
            sessionFailed ? (
              <div role="alert">
                <p>{translateError(sessionError, t('session.loadFailed'))}</p>
                <Button variant="secondary" onClick={onRetrySession}>
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
          onOpenChange={onProjectsOpenChange}
          projects={[...projects]}
          onChoose={async (id) => {
            await onCreateProjectSession(id);
          }}
          onGit={(project) => {
            onOpenGit(project);
            onProjectsOpenChange(false);
          }}
        />
      ) : null}
      <SessionManagementController
        request={sessionAction}
        sessions={[...sessions]}
        getCurrentPath={getCurrentPath}
        onOpenSession={onOpenSession}
        onClose={onCloseSessionAction}
      />
      <WorkspaceNotice message={notice} />
    </>
  );
}
