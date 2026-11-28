/**
 * @file 显示会话关联的工作树及其恢复操作。
 * @implementation 暂停不可用目录的发送，用已核对快照在原位置恢复工作树。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { useRef, useState } from 'react';
import { ArchiveRestore, GitBranch } from 'lucide-react';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { translateError, useUiTranslation } from '@/i18n';
import { useRestoreWorktree } from '@/use-query/sessions/use-restore-worktree';
import type { GitSessionWorkspace } from '@shared/git-workbench';
import type { Session } from '@shared/types';
import './git.css';
import { Input } from '@/components/ui/input';

export function SessionWorktree({
  session,
  workspace,
  onShowTree,
  onRefresh,
}: {
  session: Session;
  workspace: GitSessionWorkspace;
  onShowTree: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useUiTranslation('git');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const request = useRef<string | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const restore = useRestoreWorktree(session.id, session.projectId);
  const requireBranch =
    workspace.needsBranch ||
    (restore.error instanceof ApiError && restore.error.code === 'GIT_RESTORE_BRANCH_REQUIRED');
  const canRestore = workspace.state === 'snapshotted';
  const retained = session.status === 'archived' ? workspace.retained : undefined;

  async function submit() {
    const requestId = request.current ?? crypto.randomUUID();
    request.current = requestId;
    try {
      await restore.mutateAsync({ requestId, ...(requireBranch ? { branch: name.trim() } : {}) });
      setOpen(false);
      await onRefresh();
    } catch (error) {
      if (error instanceof ApiError && error.code) request.current = undefined;
    }
  }

  return (
    <div className="git-session-worktree">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="git-session-chip"
        title={workspace.retainedPath ?? workspace.path}
        onClick={onShowTree}
      >
        <GitBranch data-icon="inline-start" aria-hidden="true" />
        <span className="truncate">{workspace.branch}</span>
        <small>{t(workspace.mode === 'linked' ? 'scope.managed' : 'scope.project')}</small>
      </Button>
      {workspace.state !== 'ready' || retained ? (
        <div className="git-session-state">
          <div role="status">
            <p>
              {t(
                workspace.state === 'ready'
                  ? 'worktree.archivedRetained'
                  : `state.${workspace.state}`,
              )}
            </p>
            <p className="git-hint">
              {retained ? t(`retained.${retained}`) : t('restore.sendingPaused')}
            </p>
            {workspace.retainedPath ? <p className="git-path">{workspace.retainedPath}</p> : null}
          </div>
          {canRestore ? (
            <Button ref={trigger} type="button" size="sm" onClick={() => setOpen(true)}>
              <ArchiveRestore data-icon="inline-start" aria-hidden="true" />
              {t('restore.title')}
            </Button>
          ) : workspace.state === 'ready' ? (
            <Button type="button" size="sm" variant="outline" onClick={onShowTree}>
              {t('worktree.manage')}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => void onRefresh()}>
              {t('board.refresh')}
            </Button>
          )}
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!restore.isPending) setOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={!restore.isPending}
          onCloseAutoFocus={(event) => {
            if (trigger.current?.isConnected) {
              event.preventDefault();
              trigger.current.focus({ preventScroll: true });
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('restore.title')}</DialogTitle>
            <DialogDescription>
              {t(requireBranch ? 'restore.descriptionBranch' : 'restore.description')}
            </DialogDescription>
          </DialogHeader>
          <form
            className="git-restore-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!restore.isPending && (!requireBranch || name.trim())) void submit();
            }}
          >
            <p className="git-path">{workspace.path}</p>
            {requireBranch ? (
              <label className="git-field">
                {t('create.branch')}
                <Input
                  className="field"
                  value={name}
                  required
                  maxLength={240}
                  spellCheck={false}
                  disabled={restore.isPending}
                  onChange={(event) => {
                    setName(event.target.value);
                    request.current = undefined;
                  }}
                />
              </label>
            ) : null}
            {restore.error ? (
              <p role="alert" className="text-destructive">
                {translateError(restore.error, t('errors.failed'))}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={restore.isPending}
                onClick={() => setOpen(false)}
              >
                {t('restore.cancel')}
              </Button>
              <Button type="submit" disabled={restore.isPending || (requireBranch && !name.trim())}>
                {t(restore.isPending ? 'restore.progress' : 'restore.title')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
