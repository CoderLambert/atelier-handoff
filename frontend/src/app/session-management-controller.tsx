/**
 * @file 管理会话重命名、归档、恢复与删除弹窗及提交流程。
 * @implementation 独立持有表单状态、并发提交锁、删除草稿清理、缓存失效与关闭焦点归还，避免污染工作区外壳状态。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { useRef, useState } from 'react';
import type { Session } from '@shared/types';
import { workspaceSessionId } from '@shared/workspace-location';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { translateError, useUiTranslation } from '@/i18n';
import { useDeleteSession } from '@/use-query/sessions/use-delete-session';
import { useUpdateSession } from '@/use-query/sessions/use-update-session';
import { useWorkspaceCache } from '@/use-query/workspace/use-workspace-cache';
import { deleteDraft } from './drafts';
import type { SessionAction } from './types';
import { selectSessionAfterDelete } from './workspace-state';

const sessionActions = {
  rename: 'session.rename',
  archive: 'session.archive',
  restore: 'session.restore',
  delete: 'session.delete',
} as const;

export interface SessionActionRequest {
  type: SessionAction;
  session: Session;
  trigger: HTMLElement | null;
}

export function SessionManagementController({
  request,
  sessions,
  getCurrentPath,
  onOpenSession,
  onClose,
}: {
  request?: SessionActionRequest;
  sessions: readonly Session[];
  getCurrentPath: () => string;
  onOpenSession: (id?: string) => void;
  onClose: () => void;
}) {
  const { t } = useUiTranslation('workbench');
  const cache = useWorkspaceCache();
  const updateSession = useUpdateSession();
  const removeSession = useDeleteSession();
  const [prevRequest, setPrevRequest] = useState<SessionActionRequest>();
  const [title, setTitle] = useState('');
  const [managingSession, setManagingSession] = useState(false);
  const [managementError, setManagementError] = useState('');
  const managingLock = useRef(false);
  const triggerRef = useRef<HTMLElement | null>(null);

  if (request !== prevRequest) {
    setPrevRequest(request);
    if (request) {
      setTitle(request.session.title);
      setManagementError('');
    }
  }
  if (request) {
    triggerRef.current = request.trigger;
  }

  async function manageSession(current: SessionActionRequest) {
    if (managingLock.current) return;
    managingLock.current = true;
    setManagingSession(true);
    setManagementError('');
    try {
      const { type, session: target } = current;
      if (type === 'delete') {
        await deleteDraft(target.id, () => removeSession.mutateAsync(target.id));
        if (workspaceSessionId(getCurrentPath()) === target.id) {
          onOpenSession(selectSessionAfterDelete(sessions, target));
        }
        cache.removeSessionSnapshot(target.id);
        cache.invalidateSessions();
      } else {
        if (type === 'restore') {
          const { workspace } = await cache.fetchSessionSnapshot(target.id);
          if (workspace && workspace.state !== 'ready') {
            onOpenSession(target.id);
            onClose();
            return;
          }
        }
        await updateSession.mutateAsync({
          id: target.id,
          ...(type === 'rename'
            ? { title: title.trim() }
            : { status: type === 'archive' ? 'archived' : 'active' }),
        });
        void cache.revalidateSession(target.id);
        cache.invalidateProjectGit(target.projectId);
      }
      onClose();
      await cache.invalidateBootstrap();
    } catch (error) {
      setManagementError(translateError(error, t('session.actionFailed')));
    } finally {
      managingLock.current = false;
      setManagingSession(false);
    }
  }

  const actionLabel = request ? t(sessionActions[request.type]) : '';

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open && !managingSession) onClose();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          const trigger = triggerRef.current;
          if (trigger?.isConnected) {
            event.preventDefault();
            trigger.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>{request?.session.title}</DialogDescription>
        </DialogHeader>
        {request?.type === 'rename' ? (
          <label className="grid gap-2">
            {t('session.name')}
            <input
              className="field"
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        ) : null}
        {request?.type === 'delete' ? (
          <p className="text-sm">{t('session.deleteWarning')}</p>
        ) : null}
        {managementError ? (
          <p role="alert" className="text-sm text-destructive">
            {managementError}
          </p>
        ) : null}
        <div className="dialog-actions">
          <Button variant="secondary" disabled={managingSession} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant={request?.type === 'delete' ? 'destructive' : 'default'}
            disabled={managingSession || (request?.type === 'rename' && !title.trim())}
            onClick={() => {
              if (request) void manageSession(request);
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
