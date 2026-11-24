/**
 * @file 封装 Git 提交历史的关键词防抖检索与多维筛选状态。
 * @implementation 提供 250ms 防抖同步、作者与时间范围筛选及条件重置，派发契约查询参数。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GitHistoryQuery } from '@shared/git-workbench';

export function useGitCommitFilters() {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [authorFilter, setAuthorFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState('all');

  // 250ms 防抖同步搜索词
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const hasActiveFilters =
    searchInput.trim() !== '' || authorFilter !== 'all' || timeFilter !== 'all';

  const resetFilters = useCallback(() => {
    setSearchInput('');
    setDebouncedSearch('');
    setAuthorFilter('all');
    setTimeFilter('all');
  }, []);

  const filters = useMemo<GitHistoryQuery>(
    () => ({
      query: debouncedSearch.trim() || undefined,
      author: authorFilter !== 'all' ? authorFilter : undefined,
      since: timeFilter !== 'all' ? timeFilter : undefined,
    }),
    [debouncedSearch, authorFilter, timeFilter],
  );

  return {
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
  };
}
