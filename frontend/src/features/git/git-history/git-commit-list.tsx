/**
 * @file 展示 Git 提交记录时间线列表与无限滚动加载状态。
 * @implementation 使用 IntersectionObserver 哨兵元素实现自动分页，提供短 Hash 复制与骨架屏反馈。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import type { GitCommit } from '@shared/git-workbench';
import { GitCommitRow } from './git-commit-row';
import { GitCommitSkeleton } from './git-commit-skeleton';

export interface GitCommitListProps {
  commits: GitCommit[];
  selectedCommitOid?: string;
  onSelectCommit: (oid: string) => void;
  searchHighlightQuery: string;
  hasActiveFilters: boolean;
  dateFormat: Intl.DateTimeFormat;
  hasNextPage?: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  onFetchNextPage: () => void;
}

export function GitCommitList({
  commits,
  selectedCommitOid,
  onSelectCommit,
  searchHighlightQuery,
  hasActiveFilters,
  dateFormat,
  hasNextPage,
  isFetchingNextPage,
  isFetchNextPageError,
  onFetchNextPage,
}: GitCommitListProps) {
  const { t } = useUiTranslation('git');
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isLoadingMoreRef = useRef(false);

  // 监听底部 1px 哨兵，在距底部 240px 时触发下一页加载
  useEffect(() => {
    const container = scrollContainerRef.current;
    const sentinel = sentinelRef.current;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          entry?.isIntersecting &&
          hasNextPage &&
          !isFetchingNextPage &&
          !isLoadingMoreRef.current
        ) {
          isLoadingMoreRef.current = true;
          onFetchNextPage();
        }
      },
      {
        root: container,
        rootMargin: '0px 0px 240px 0px',
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, onFetchNextPage]);

  // 当加载完成时释放状态锁
  useEffect(() => {
    if (!isFetchingNextPage) {
      isLoadingMoreRef.current = false;
    }
  }, [isFetchingNextPage]);

  const handleCopyHash = useCallback(async (e: React.MouseEvent, oid: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(oid);
      setCopiedHash(oid);
      setTimeout(() => {
        setCopiedHash((prev) => (prev === oid ? null : prev));
      }, 2000);
    } catch {}
  }, []);

  if (commits.length === 0) {
    return (
      <div className="git-history-list" ref={scrollContainerRef}>
        <div className="git-empty-commits">
          <Search className="git-empty-icon" aria-hidden="true" />
          <p className="git-empty-title">
            {hasActiveFilters ? t('history.noMatchingCommits') : t('history.empty')}
          </p>
          {hasActiveFilters && (
            <p className="git-empty-desc">{t('history.noMatchingCommitsHint')}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="git-history-list" ref={scrollContainerRef}>
      <ul>
        {commits.map((item) => (
          <GitCommitRow
            key={item.oid}
            commit={item}
            isSelected={item.oid === selectedCommitOid}
            isCopied={copiedHash === item.oid}
            dateFormat={dateFormat}
            searchHighlightQuery={searchHighlightQuery}
            onSelect={onSelectCommit}
            onCopyHash={handleCopyHash}
          />
        ))}
      </ul>

      {/* 底部骨架屏加载中状态 */}
      {isFetchingNextPage && <GitCommitSkeleton />}

      {/* 底部已加载全部状态 */}
      {!hasNextPage && (
        <div className="git-end-of-list">
          <span className="git-end-line" aria-hidden="true" />
          <span className="git-end-text">{t('history.initialCommit')}</span>
          <span className="git-end-line" aria-hidden="true" />
        </div>
      )}

      {/* 底部加载失败重试条 */}
      {isFetchNextPageError && (
        <div className="git-load-failed">
          <button
            type="button"
            className="git-retry-button"
            onClick={onFetchNextPage}
          >
            <RotateCcw size={13} aria-hidden="true" />
            <span>{t('history.loadFailed')}</span>
          </button>
        </div>
      )}

      {/* 1px 透明哨兵元素 */}
      <div ref={sentinelRef} style={{ height: 1 }} aria-hidden="true" />
    </div>
  );
}
