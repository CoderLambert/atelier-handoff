/**
 * @file 展示 Git 提交历史顶部的关键词搜索与筛选工具栏。
 * @implementation 提供防抖搜索输入、作者与时间快捷下拉及当前分支统计状态展示。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { memo } from 'react';
import { Search, X } from 'lucide-react';
import { useUiTranslation } from '@/i18n';

export interface GitCommitToolbarProps {
  currentBranchName: string;
  totalCount: number;
  authors: string[];
  searchInput: string;
  onSearchInputChange: (query: string) => void;
  authorFilter: string;
  onAuthorFilterChange: (author: string) => void;
  timeFilter: string;
  onTimeFilterChange: (time: string) => void;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
}

export const GitCommitToolbar = memo(function GitCommitToolbar({
  currentBranchName,
  totalCount,
  authors,
  searchInput,
  onSearchInputChange,
  authorFilter,
  onAuthorFilterChange,
  timeFilter,
  onTimeFilterChange,
  hasActiveFilters,
  onResetFilters,
}: GitCommitToolbarProps) {
  const { t } = useUiTranslation('git');

  return (
    <div className="git-commit-toolbar">
      <div className="git-commit-toolbar-filters">
        {/* 关键词搜索框 */}
        <div className="git-commit-search-wrapper">
          <Search className="git-search-icon" aria-hidden="true" />
          <input
            type="text"
            className="git-commit-search-input"
            placeholder={t('history.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => onSearchInputChange(e.target.value)}
          />
          {searchInput && (
            <button
              type="button"
              className="git-clear-btn"
              title={t('history.searchClear')}
              onClick={() => onSearchInputChange('')}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* 作者筛选下拉 */}
        <select
          className="git-filter-select"
          aria-label={t('history.filterAuthor')}
          value={authorFilter}
          onChange={(e) => onAuthorFilterChange(e.target.value)}
        >
          <option value="all">{t('history.allAuthors')}</option>
          {authors.map((auth) => (
            <option key={auth} value={auth}>
              {auth}
            </option>
          ))}
        </select>

        {/* 时间范围筛选下拉 */}
        <select
          className="git-filter-select"
          aria-label={t('history.filterTime')}
          value={timeFilter}
          onChange={(e) => onTimeFilterChange(e.target.value)}
        >
          <option value="all">{t('history.allTime')}</option>
          <option value="7d">{t('history.past7Days')}</option>
          <option value="30d">{t('history.past30Days')}</option>
        </select>

        {/* 重置筛选按钮 */}
        {hasActiveFilters && (
          <button
            type="button"
            className="git-reset-filters-btn"
            onClick={onResetFilters}
          >
            {t('history.resetFilters')}
          </button>
        )}
      </div>

      {/* 右侧统计区 */}
      <div className="git-commit-toolbar-stats">
        <span className="git-active-branch-pill">{currentBranchName}</span>
        <span className="git-commit-count-label">
          {t('history.commitCount', { count: totalCount })}
        </span>
      </div>
    </div>
  );
});
