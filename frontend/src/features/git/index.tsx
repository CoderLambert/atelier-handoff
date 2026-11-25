/**
 * @file 组织 Git 侧栏、全窗口和开发会话入口。
 * @implementation 保留工作树及标签选择，集成智能远端同步、异常状态横幅、Toast 通知并协调弹窗。
 * @updated 2026-11-25T03:31:00+08:00
 */
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { GitBranch, Maximize2, Minimize2, Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUiTranslation } from '@/i18n';
import { useGitOverview } from '@/use-query/git/use-git-overview';
import { useGitRepoStatus } from '@/use-query/git/use-git-repo-status';
import type { Project } from '@shared/types';
import { CreateDevelopmentSession } from './create-development-session';
import { GitFilesView, GitHistoryView, GitQueryFeedback } from './git-views';
import { GitWorktreesView } from './git-worktrees';
import { GitSyncButton } from './git-sync-button';
import { GitStateBanner } from './git-state-banner';
import { useGitToast } from './hooks/use-git-toast';
import './git.css';

const tabs = ['files', 'history', 'worktrees'] as const;
type GitTab = (typeof tabs)[number];

export default function GitBoard({
  project,
  initialTree,
  initialTab,
  expanded,
  onToggleExpanded,
  busy,
  onBusy,
  onClose,
  onCreated,
}: {
  project: Project;
  initialTree?: string;
  initialTab?: GitTab;
  expanded: boolean;
  onToggleExpanded?: () => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useUiTranslation('git');
  const { overview, refresh } = useGitOverview(project.id);
  const [tab, setTab] = useState<GitTab>(initialTab ?? 'files');
  const [selectedTree, selectTree] = useState(initialTree ?? project.id);
  const [creating, setCreating] = useState(false);
  const baseId = useId();
  const panel = useRef<HTMLElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const expandLabel = t(expanded ? 'board.dock' : 'board.expand');

  useLayoutEffect(() => {
    const element = panel.current;
    if (element && !element.contains(document.activeElement))
      element.focus({ preventScroll: true });
  }, [expanded]);
  const data = overview.data;
  const tree =
    data?.worktrees.find(({ id }) => id === selectedTree) ??
    data?.worktrees.find(({ id }) => id === project.id);

  const { status: repoStatus, invalidate: invalidateRepoStatus } = useGitRepoStatus(tree?.path);
  const { showToast, ToastRenderer } = useGitToast();

  const handleRefreshAll = useCallback(() => {
    void refresh();
    void invalidateRepoStatus();
  }, [refresh, invalidateRepoStatus]);

  return (
    <section
      className="git-board"
      data-expanded={expanded || undefined}
      ref={panel}
      role={expanded ? 'dialog' : 'region'}
      aria-modal={expanded || undefined}
      aria-labelledby={baseId + '-title'}
      aria-describedby={baseId + '-description'}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          !(event.target instanceof Node) ||
          !event.currentTarget.contains(event.target) ||
          busy ||
          creating
        )
          return;
        event.preventDefault();
        if (expanded && onToggleExpanded) onToggleExpanded();
        else onClose();
      }}
    >
      <header className="git-board-heading">
        <div className="git-board-title">
          <GitBranch aria-hidden="true" />
          <h2 id={baseId + '-title'}>{t('title')}</h2>
          <span title={project.name} className="git-board-project truncate">
            {project.name}
          </span>
        </div>
        <div className="git-board-actions">
          {onToggleExpanded ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={expandLabel}
              title={expandLabel}
              onClick={onToggleExpanded}
            >
              {expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={busy}
            aria-label={t('board.close')}
            title={t('board.close')}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <p className="sr-only" id={baseId + '-description'}>
          {t('board.description', { project: project.name })}
        </p>
      </header>
      <div className="git-board-controls">
        <div className="git-tablist" role="tablist" aria-label={t('board.views')}>
          {tabs.map((view, index) => (
            <Button
              key={view}
              role="tab"
              size="sm"
              variant="ghost"
              id={baseId + '-' + view}
              aria-controls={baseId + '-panel'}
              aria-selected={view === tab}
              tabIndex={view === tab ? 0 : -1}
              disabled={busy}
              onClick={() => setTab(view)}
              onKeyDown={(event) => {
                const targets: Record<string, number> = {
                  ArrowLeft: (index - 1 + tabs.length) % tabs.length,
                  ArrowRight: (index + 1) % tabs.length,
                  Home: 0,
                  End: tabs.length - 1,
                };
                const next = tabs[targets[event.key] ?? -1];
                if (!next) return;
                event.preventDefault();
                setTab(next);
                document.getElementById(baseId + '-' + next)?.focus();
              }}
            >
              {t(`board.${view}`)}
            </Button>
          ))}
        </div>
        <div className="git-board-actions">
          {data && tree && tab !== 'worktrees' ? (
            <Select value={tree.id} onValueChange={selectTree}>
              <SelectTrigger
                className="git-tree-select"
                size="sm"
                aria-label={t('worktree.select')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {data.worktrees
                  .filter((item) => item.scope !== 'external')
                  .map((item) => (
                    <SelectItem value={item.id} key={item.id}>
                      {item.scope === 'project'
                        ? t('scope.project')
                        : (item.branch ?? t('worktree.detached'))}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : null}
          <GitSyncButton
            cwd={tree?.path}
            status={repoStatus}
            onRefreshAll={handleRefreshAll}
            showToast={showToast}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy || overview.isFetching}
            aria-label={t('board.refresh')}
            title={t('board.refresh')}
            onClick={handleRefreshAll}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            ref={createTrigger}
            disabled={!data || Boolean(overview.error) || busy}
            onClick={() => setCreating(true)}
          >
            <Plus data-icon="inline-start" aria-hidden="true" />
            {t('create.title')}
          </Button>
        </div>
      </div>
      <GitStateBanner
        cwd={tree?.path}
        status={repoStatus}
        onViewConflicts={() => setTab('files')}
        onRefreshAll={handleRefreshAll}
        showToast={showToast}
        onCreateBranch={() => setCreating(true)}
      />
      <div
        className="git-panel"
        role="tabpanel"
        id={baseId + '-panel'}
        aria-labelledby={baseId + '-' + tab}
      >
        {!data || overview.error || !tree ? (
          <GitQueryFeedback error={overview.error} retry={() => void overview.refetch()} />
        ) : tab === 'worktrees' ? (
          <GitWorktreesView
            projectId={project.id}
            tree={tree}
            trees={data.worktrees}
            onSelect={selectTree}
            onFiles={() => setTab('files')}
            onBusy={onBusy}
          />
        ) : tab === 'files' ? (
          <GitFilesView
            key={tree.id}
            projectId={project.id}
            tree={tree}
            busy={busy}
            onBusy={onBusy}
            repoStatus={repoStatus}
            onRefreshAll={handleRefreshAll}
            showToast={showToast}
          />
        ) : (
          <GitHistoryView
            key={tree.id}
            projectId={project.id}
            overview={data}
            tree={tree}
            repoStatus={repoStatus}
            onRefreshAll={handleRefreshAll}
            showToast={showToast}
          />
        )}
      </div>
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open && !busy) setCreating(false);
        }}
      >
        <DialogContent
          className="git-create-dialog"
          showCloseButton={!busy}
          onCloseAutoFocus={(event) => {
            if (!createTrigger.current?.isConnected) return;
            event.preventDefault();
            createTrigger.current.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle className="git-board-title">
              <GitBranch aria-hidden="true" />
              {t('create.title')}
            </DialogTitle>
            <DialogDescription>{t('create.description')}</DialogDescription>
          </DialogHeader>
          <CreateDevelopmentSession
            projectId={project.id}
            branches={data?.branches ?? []}
            sourceWorktreeId={
              tree?.scope === 'managed' && tree.state === 'ready' ? tree.id : undefined
            }
            onBack={() => setCreating(false)}
            onCreated={onCreated}
            onBusy={onBusy}
          />
        </DialogContent>
      </Dialog>
      <ToastRenderer />
    </section>
  );
}
