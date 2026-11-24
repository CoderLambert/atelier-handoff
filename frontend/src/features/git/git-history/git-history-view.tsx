/**
 * @file 组合 Git 分支侧栏、提交筛选工具栏、提交历史列表与差异详情。
 * @implementation 协调分支选择、条件防抖、服务端/客户端双重过滤及选中提交的差异展开。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { useCallback, useMemo, useState } from 'react';
import { useUiTranslation } from '@/i18n';
import { useGitHistory } from '@/use-query/git/use-git-history';
import type { GitBranch, GitOverview, GitWorktree } from '@shared/git-workbench';
import { GitBranchSidebar } from './git-branch-sidebar';
import { GitCommitList } from './git-commit-list';
import { GitCommitToolbar } from './git-commit-toolbar';
import { useGitCommitFilters } from './use-git-commit-filters';

export interface GitHistoryViewProps {
  projectId: string;
  overview: GitOverview;
  tree: GitWorktree;
  diffRenderer: (commitOid: string) => React.ReactNode;
  feedbackRenderer: (error?: unknown, retry?: () => void) => React.ReactNode;
}

export function GitHistoryView({
  projectId,
  overview,
  tree,
  diffRenderer,
  feedbackRenderer,
}: GitHistoryViewProps) {
  const { t, locale } = useUiTranslation('git');
  const [ref, selectRef] = useState<GitBranch>();
  const [selection, selectCommit] = useState<{ anchor: string; oid: string }>();

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
  const commit = selection?.anchor === anchor ? selection?.oid : undefined;

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

  const totalCount =
    hasActiveFilters
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
      if (anchor) selectCommit({ anchor, oid });
    },
    [anchor],
  );

  const handleFetchNextPage = useCallback(() => {
    void history.fetchNextPage();
  }, [history]);

  return (
    <div className="git-split">
      {/* 1. 左侧分支栏 */}
      <GitBranchSidebar
        overview={overview}
        tree={tree}
        selectedBranch={branch}
        onSelectHead={handleSelectHead}
        onSelectBranch={handleSelectBranch}
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
            hasNextPage={history.hasNextPage}
            isFetchingNextPage={history.isFetchingNextPage}
            isFetchNextPageError={history.isFetchNextPageError}
            onFetchNextPage={handleFetchNextPage}
          />
        )}

        {/* 选中提交的差异详情 */}
        {commit ? (
          <section className="git-detail" aria-label={t('diff.commit', { oid: commit })}>
            <h3 className="git-detail-title" title={commit}>
              <code>{commit.slice(0, 12)}</code>
            </h3>
            {diffRenderer(commit)}
          </section>
        ) : (
          <p className="git-history-hint">{t('history.choose')}</p>
        )}
      </div>
    </div>
  );
}
