/**
 * @file 组织 Git 侧栏、全窗口和文件阅读标签。
 * @implementation 管理工作树、功能视图和文件版本标签及其滚动位置，协调同步、异常提示、通知和弹窗。
 * @updated 2026-11-25T17:09:41+08:00
 */
import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCompareArrows,
  History,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { GitFileReader, type GitReaderScroll } from './git-file-reader';
import type { QuoteGitCode } from './git-code-selection';
import { gitOpenFileKey, type GitOpenFile } from './git-open-file';
import './git.css';

const tabs = ['files', 'history', 'worktrees'] as const;
const tabIcons = { files: GitCompareArrows, history: History, worktrees: FolderGit2 };
type GitTab = (typeof tabs)[number];
type OpenFileTab = GitOpenFile & { key: string };

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
  onQuoteCode,
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
  onQuoteCode?: QuoteGitCode;
}) {
  const { t, locale } = useUiTranslation('git');
  const { overview, refresh } = useGitOverview(project.id);
  const [tab, setTab] = useState<GitTab>(initialTab ?? 'files');
  const [selectedTree, selectTree] = useState(initialTree ?? project.id);
  const [creating, setCreating] = useState(false);
  const [fileTabs, setFileTabs] = useState<{ items: OpenFileTab[]; active?: string }>({
    items: [],
  });
  const baseId = useId();
  const panel = useRef<HTMLElement>(null);
  const createTrigger = useRef<HTMLButtonElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const fileStrip = useRef<HTMLDivElement>(null);
  const focusSelectedTab = useRef(false);
  const readerScroll = useRef(new Map<string, GitReaderScroll>());
  const expandLabel = t(expanded ? 'board.dock' : 'board.expand');
  const fileTabId = (key: string) => baseId + '-file-' + encodeURIComponent(key);
  const selectedTabId = fileTabs.active ? fileTabId(fileTabs.active) : baseId + '-' + tab;
  const fileVersion = ({ target }: GitOpenFile) => {
    const source = t(`diff.source.${target.source}`);
    return target.kind === 'history' ? source + ' ' + target.commitOid.slice(0, 8) : source;
  };
  const selectFile = (key: string) => setFileTabs((current) => ({ ...current, active: key }));

  const openFile = (file: GitOpenFile) => {
    const key = gitOpenFileKey(file);
    focusSelectedTab.current = true;
    setFileTabs((current) => ({
      items: current.items.some((item) => item.key === key)
        ? current.items
        : [...current.items, { ...file, key }],
      active: key,
    }));
  };
  const closeFile = (key: string) => {
    readerScroll.current.delete(key);
    focusSelectedTab.current = true;
    setFileTabs((current) => {
      const index = current.items.findIndex((item) => item.key === key);
      if (index === -1) return current;
      const items = current.items.filter((item) => item.key !== key);
      const replacement = items[index] ?? items[index - 1];
      return { items, active: current.active === key ? replacement?.key : current.active };
    });
  };
  const selectView = (view: GitTab) => {
    setTab(view);
    setFileTabs((current) => (current.active ? { ...current, active: undefined } : current));
  };

  useLayoutEffect(() => {
    if (!focusSelectedTab.current) return;
    focusSelectedTab.current = false;
    document.getElementById(selectedTabId)?.focus();
  }, [selectedTabId, fileTabs.items.length]);

  useLayoutEffect(() => {
    if (!fileTabs.active) return;
    const strip = fileStrip.current;
    const item = document.getElementById(selectedTabId)?.parentElement;
    if (!strip || !item) return;
    const reveal = () => {
      const bounds = strip.getBoundingClientRect();
      const tabBounds = item.getBoundingClientRect();
      if (tabBounds.left < bounds.left) strip.scrollLeft += tabBounds.left - bounds.left;
      else if (tabBounds.right > bounds.right) strip.scrollLeft += tabBounds.right - bounds.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    observer.observe(item);
    return () => observer.disconnect();
  }, [fileTabs.active, selectedTabId, locale]);

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
      <div className="git-board-controls" data-open-files={fileTabs.items.length > 0 || undefined}>
        <div
          className="git-workbench-tabs"
          role="tablist"
          aria-label={t('board.views')}
          ref={tabList}
          onKeyDown={(event) => {
            if (
              busy ||
              !(event.target instanceof HTMLButtonElement) ||
              event.target.getAttribute('role') !== 'tab'
            )
              return;
            const elements = Array.from(
              tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
            );
            const index = elements.indexOf(event.target);
            const positions: Record<string, number> = {
              ArrowLeft: (index - 1 + elements.length) % elements.length,
              ArrowRight: (index + 1) % elements.length,
              Home: 0,
              End: elements.length - 1,
            };
            const next = elements[positions[event.key] ?? -1];
            if (!next) return;
            event.preventDefault();
            next.click();
            next.focus();
          }}
        >
          <div className="git-tablist" role="presentation">
            {tabs.map((view) => {
              const Icon = tabIcons[view];
              const label = t(`board.${view}`);
              return (
                <Button
                  key={view}
                  role="tab"
                  size="sm"
                  variant="ghost"
                  id={baseId + '-' + view}
                  aria-controls={baseId + '-panel'}
                  aria-label={label}
                  title={label}
                  aria-selected={!fileTabs.active && view === tab}
                  tabIndex={!fileTabs.active && view === tab ? 0 : -1}
                  disabled={busy}
                  onClick={() => selectView(view)}
                >
                  <Icon className="git-workbench-tab-icon" aria-hidden="true" />
                  <span className="git-workbench-tab-label">{label}</span>
                </Button>
              );
            })}
          </div>
          {fileTabs.items.length > 0 ? (
            <div className="git-reader-tabs" role="presentation" ref={fileStrip}>
              {fileTabs.items.map((file) => {
                const id = fileTabId(file.key);
                const version = fileVersion(file);
                const label = t('diff.fileTab', { path: file.target.path, version });
                const selected = fileTabs.active === file.key;
                return (
                  <div
                    className="git-reader-tab"
                    role="presentation"
                    key={file.key}
                    data-selected={selected || undefined}
                  >
                    <Button
                      role="tab"
                      type="button"
                      variant="ghost"
                      size="sm"
                      id={id}
                      aria-controls={id + '-panel'}
                      aria-label={label}
                      title={label}
                      aria-selected={selected}
                      aria-keyshortcuts="Delete"
                      tabIndex={selected ? 0 : -1}
                      disabled={busy}
                      onClick={() => selectFile(file.key)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Delete') return;
                        event.preventDefault();
                        closeFile(file.key);
                      }}
                    >
                      <FileCode2 aria-hidden="true" />
                      <span className="git-reader-tab-name">
                        {file.target.path.split('/').at(-1)}
                      </span>
                      <small className="git-reader-tab-version">{version}</small>
                    </Button>
                    <Button
                      type="button"
                      className="git-reader-tab-close"
                      variant="ghost"
                      size="icon-xs"
                      tabIndex={-1}
                      aria-label={t('diff.closeFileTab', { path: file.target.path, version })}
                      title={t('diff.closeFileTab', { path: file.target.path, version })}
                      disabled={busy}
                      onClick={() => closeFile(file.key)}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
        {fileTabs.items.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="git-reader-tab-menu"
                aria-label={t('diff.openFiles')}
                title={t('diff.openFiles')}
                disabled={busy}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="max-h-[min(50vh,360px)] max-w-[min(80vw,540px)] overflow-auto">
              {fileTabs.items.map((file) => (
                <DropdownMenuItem
                  key={file.key}
                  onSelect={() => {
                    selectFile(file.key);
                    requestAnimationFrame(() =>
                      document.getElementById(fileTabId(file.key))?.focus(),
                    );
                  }}
                >
                  <FileCode2 size={14} aria-hidden="true" />
                  <span className="min-w-0 truncate" title={file.target.path}>
                    {file.target.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{fileVersion(file)}</span>
                  {fileTabs.active === file.key ? <Check size={14} aria-hidden="true" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {!fileTabs.active && (
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
        )}
      </div>
      {!fileTabs.active && (
        <GitStateBanner
          cwd={tree?.path}
          status={repoStatus}
          onViewConflicts={() => setTab('files')}
          onRefreshAll={handleRefreshAll}
          showToast={showToast}
          onCreateBranch={() => setCreating(true)}
        />
      )}
      <div
        className="git-panel"
        role="tabpanel"
        id={baseId + '-panel'}
        aria-labelledby={baseId + '-' + tab}
        hidden={Boolean(fileTabs.active)}
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
            onOpenFile={openFile}
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
            onOpenFile={openFile}
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
      {fileTabs.items.map((file) => {
        const id = fileTabId(file.key);
        const active = fileTabs.active === file.key;
        return (
          <div
            className="git-panel git-reader-panel"
            role="tabpanel"
            key={file.key}
            id={id + '-panel'}
            aria-labelledby={id}
            hidden={!active}
          >
            {active && (
              <GitFileReader
                projectId={project.id}
                file={file}
                showToast={showToast}
                onQuoteCode={onQuoteCode}
                checkout={data?.worktrees.find(({ id }) => id === file.worktreeId)?.branch ?? undefined}
                position={readerScroll.current.get(file.key)}
                onScroll={(position) => readerScroll.current.set(file.key, position)}
              />
            )}
          </div>
        );
      })}
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
