/**
 * @file 组合 Git 分支侧栏、提交筛选工具栏、提交历史列表与差异详情。
 * @implementation 协调分支选择、提交列表右键菜单、新建分支与 Reset/Revert/Cherry-pick 对话框。
 * @updated 2026-11-27T21:55:00+08:00
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, GitBranch as BranchIcon, RotateCcw } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import { useGitHistory } from '@/use-query/git/use-git-history';
import type { GitBranch, GitCommit, GitOverview, GitWorktree } from '@shared/git-workbench';
import type { GitRepoStatus } from '@shared/desktop-git';
import { GitContextMenu, type GitContextMenuItem } from '../git-context-menu';
import { GitCreateBranchModal } from '../git-branch-dialogs';
import { GitCherryPickModal, GitResetModal, GitRevertModal } from '../git-commit-dialogs';
import { GitBranchSidebar } from './git-branch-sidebar';
import { GitCommitList } from './git-commit-list';
import { GitCommitToolbar } from './git-commit-toolbar';
import { GitCommitDetailPane } from './git-commit-detail-pane';
import { useGitCommitFilters } from './use-git-commit-filters';
import type { GitOpenFile } from '../git-open-file';
import { GitQueryFeedback } from '../git-views';

export interface GitHistoryViewProps {
  projectId: string;
  overview: GitOverview;
  tree: GitWorktree;
  onOpenFile: (file: GitOpenFile) => void;
  diffRenderer?: (
    commitOid: string,
    commitInfo?: GitCommit,
    onClose?: () => void,
  ) => React.ReactNode;
  feedbackRenderer?: (error?: unknown, retry?: () => void) => React.ReactNode;
  onRefreshAll?: () => void;
  showToast?: (message: string, type?: 'success' | 'error', stderr?: string) => void;
  repoStatus?: GitRepoStatus | null;
}

const defaultFeedbackRenderer = (error?: unknown, retry?: () => void) => (
  <GitQueryFeedback error={error} retry={retry ?? (() => {})} />
);

export function GitHistoryView({
  projectId,
  overview,
  tree,
  onOpenFile,
  diffRenderer,
  feedbackRenderer = defaultFeedbackRenderer,
  onRefreshAll,
  showToast,
  repoStatus,
}: GitHistoryViewProps) {
  const { t, locale } = useUiTranslation('git');
  const [ref, selectRef] = useState<GitBranch>();
  const [selection, selectCommit] = useState<GitCommit>();
  const detailPane = useRef<HTMLDivElement>(null);
  const detailTrigger = useRef<HTMLElement>(null);

  // 快捷操作菜单与弹窗状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: GitContextMenuItem[];
  } | null>(null);
  const [createBranchState, setCreateBranchState] = useState<{
    open: boolean;
    startPoint?: string;
  }>({ open: false });
  const [resetState, setResetState] = useState<{
    open: boolean;
    commitHash: string;
    commitSubject?: string;
  } | null>(null);
  const [revertState, setRevertState] = useState<{
    open: boolean;
    commitHash: string;
    commitSubject?: string;
  } | null>(null);
  const [cherryPickState, setCherryPickState] = useState<{
    open: boolean;
    commitHash: string;
    commitSubject?: string;
  } | null>(null);

  // 提交历史检索与筛选状态
  const {
    searchInput,
    setSearchInput,
    debouncedSearch,
    authorFilter,
    setAuthorFilter,
    timeFilter,
    setTimeFilter,
    hasActiveFilters,
    resetFilters,
    filters,
  } = useGitCommitFilters();

  const branch =
    ref && overview.branches.find((item) => item.kind === ref.kind && item.name === ref.name);
  const anchor = branch?.oid ?? tree.head ?? undefined;
  const commit = selection?.oid;
  useEffect(() => {
    if (commit) detailPane.current?.focus({ preventScroll: true });
  }, [commit]);

  const history = useGitHistory(projectId, anchor, filters);
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
    [locale],
  );

  // 展开全部分页的原始提交与作者列表
  const allCommits = useMemo(
    () => history.data?.pages.flatMap(({ items }) => items) ?? [],
    [history.data],
  );

  // 客户端双重保障过滤：防止网络滞后或并发未结算时显示无关提交
  const visibleCommits = useMemo(() => {
    const query = (debouncedSearch || searchInput).trim().toLowerCase();
    if (!query && authorFilter === 'all') return allCommits;

    return allCommits.filter((item) => {
      if (query) {
        const matchSubject = item.subject.toLowerCase().includes(query);
        const matchAuthor = item.author.toLowerCase().includes(query);
        const matchOid = item.oid.toLowerCase().includes(query);
        if (!matchSubject && !matchAuthor && !matchOid) return false;
      }
      if (
        authorFilter !== 'all' &&
        !item.author.toLowerCase().includes(authorFilter.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [allCommits, debouncedSearch, searchInput, authorFilter]);

  const allAuthors = useMemo(() => {
    const set = new Set<string>();
    history.data?.pages.forEach((page) => {
      page.authors?.forEach((a) => set.add(a));
      page.items.forEach((c) => set.add(c.author));
    });
    return Array.from(set).sort();
  }, [history.data]);

  const totalCount = hasActiveFilters
    ? (history.data?.pages[0]?.totalCount ?? visibleCommits.length)
    : (history.data?.pages[0]?.totalCount ?? allCommits.length);

  const handleSelectHead = useCallback(() => {
    selectRef(undefined);
    selectCommit(undefined);
  }, []);

  const handleSelectBranch = useCallback((b: GitBranch) => {
    selectRef(b);
    selectCommit(undefined);
  }, []);

  const handleSelectCommit = useCallback(
    (oid: string) => {
      const item = visibleCommits.find((entry) => entry.oid === oid);
      if (!item) return;
      detailTrigger.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      selectCommit(item);
    },
    [visibleCommits],
  );
  const handleCloseDetail = () => {
    selectCommit(undefined);
    window.requestAnimationFrame(() => detailTrigger.current?.focus({ preventScroll: true }));
  };

  const handleFetchNextPage = useCallback(() => {
    void history.fetchNextPage();
  }, [history]);

  // 提交行右键快捷菜单
  const handleContextMenuCommit = useCallback(
    (commitItem: GitCommit, e: React.MouseEvent) => {
      const items: GitContextMenuItem[] = [
        {
          label: t('commit.menuCreateBranch'),
          icon: BranchIcon,
          onClick: () => setCreateBranchState({ open: true, startPoint: commitItem.oid }),
        },
        {
          label: t('commit.menuReset'),
          icon: RotateCcw,
          onClick: () =>
            setResetState({
              open: true,
              commitHash: commitItem.oid,
              commitSubject: commitItem.subject,
            }),
        },
        {
          label: t('commit.menuRevert'),
          icon: RotateCcw,
          onClick: () =>
            setRevertState({
              open: true,
              commitHash: commitItem.oid,
              commitSubject: commitItem.subject,
            }),
        },
        {
          label: t('commit.menuCherryPick'),
          icon: Copy,
          onClick: () =>
            setCherryPickState({
              open: true,
              commitHash: commitItem.oid,
              commitSubject: commitItem.subject,
            }),
        },
        { divider: true, label: '' },
        {
          label: t('commit.menuCopyHash'),
          icon: Copy,
          onClick: () => {
            void navigator.clipboard.writeText(commitItem.oid);
            showToast?.(t('history.hashCopied'), 'success');
          },
        },
      ];
      setContextMenu({ x: e.clientX, y: e.clientY, items });
    },
    [t, showToast],
  );

  return (
    <div className="git-split git-history-split" data-reviewing={Boolean(commit)}>
      {/* 1. 左侧分支栏 */}
      <GitBranchSidebar
        overview={overview}
        tree={tree}
        selectedBranch={branch}
        repoStatus={repoStatus}
        onSelectHead={handleSelectHead}
        onSelectBranch={handleSelectBranch}
        onRefreshAll={onRefreshAll}
        showToast={showToast}
        onOpenCreateBranch={(startPoint) => setCreateBranchState({ open: true, startPoint })}
      />

      {/* 2. 右侧提交历史区 */}
      <div className="git-history">
        <GitCommitToolbar
          currentBranchName={branch?.name ?? t('branch.head')}
          totalCount={totalCount}
          authors={allAuthors}
          searchInput={searchInput}
          onSearchInputChange={setSearchInput}
          authorFilter={authorFilter}
          onAuthorFilterChange={setAuthorFilter}
          timeFilter={timeFilter}
          onTimeFilterChange={setTimeFilter}
          hasActiveFilters={hasActiveFilters}
          onResetFilters={resetFilters}
        />

        <div className="git-history-body">
          {/* 提交列表：居左侧栏，保持 100% 完整垂直高度与独立滚动，不被底部挤压 */}
          <div className={`git-history-commits-pane ${commit ? 'with-detail' : 'full-width'}`}>
            {anchor && (!history.data || (history.error && !history.isFetchNextPageError)) ? (
              feedbackRenderer(history.error, () => void history.refetch())
            ) : (
              <GitCommitList
                commits={visibleCommits}
                selectedCommitOid={commit}
                onSelectCommit={handleSelectCommit}
                searchHighlightQuery={searchInput || debouncedSearch}
                hasActiveFilters={hasActiveFilters}
                dateFormat={dateFormat}
                cwd={tree.path}
                hasNextPage={history.hasNextPage}
                isFetchingNextPage={history.isFetchingNextPage}
                isFetchNextPageError={history.isFetchNextPageError}
                onFetchNextPage={handleFetchNextPage}
                onContextMenuCommit={handleContextMenuCommit}
              />
            )}
          </div>

          {/* 选中提交的差异详情：横向排布在右侧，提供文件过滤导航与超大差异折叠 */}
          {commit && (
            <div ref={detailPane} className="git-history-detail-pane" tabIndex={-1}>
              {diffRenderer ? (
                diffRenderer(commit, selection, handleCloseDetail)
              ) : (
                <GitCommitDetailPane
                  key={commit}
                  projectId={projectId}
                  worktreeId={tree.id}
                  onOpenFile={onOpenFile}
                  commitOid={commit}
                  commitInfo={selection}
                  onClose={handleCloseDetail}
                  showToast={showToast}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* 提交行右键菜单 */}
      {contextMenu && (
        <GitContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 从提交/HEAD 新建分支弹窗 */}
      <GitCreateBranchModal
        open={createBranchState.open}
        onOpenChange={(open) => setCreateBranchState((prev) => ({ ...prev, open }))}
        cwd={tree.path}
        startPoint={createBranchState.startPoint}
        onSuccess={() => onRefreshAll?.()}
        showToast={showToast ?? (() => {})}
      />

      {/* Reset 历史回退弹窗 */}
      {resetState && (
        <GitResetModal
          open={resetState.open}
          onOpenChange={(open) => !open && setResetState(null)}
          cwd={tree.path}
          commitHash={resetState.commitHash}
          commitSubject={resetState.commitSubject}
          onSuccess={() => onRefreshAll?.()}
          showToast={showToast ?? (() => {})}
        />
      )}

      {/* Revert 撤销提交弹窗 */}
      {revertState && (
        <GitRevertModal
          open={revertState.open}
          onOpenChange={(open) => !open && setRevertState(null)}
          cwd={tree.path}
          commitHash={revertState.commitHash}
          commitSubject={revertState.commitSubject}
          onSuccess={() => onRefreshAll?.()}
          showToast={showToast ?? (() => {})}
        />
      )}

      {/* Cherry-pick 摘取提交弹窗 */}
      {cherryPickState && (
        <GitCherryPickModal
          open={cherryPickState.open}
          onOpenChange={(open) => !open && setCherryPickState(null)}
          cwd={tree.path}
          commitHash={cherryPickState.commitHash}
          commitSubject={cherryPickState.commitSubject}
          onSuccess={() => onRefreshAll?.()}
          showToast={showToast ?? (() => {})}
        />
      )}
    </div>
  );
}
