/**
 * @file 展示 Git 提交历史分页加载时的骨架屏占位。
 * @implementation 呈现带脉冲动效的骨架条与居中加载中提示，优化无限滚动加载视觉体验。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { memo } from 'react';
import { Loader2 } from 'lucide-react';
import { useUiTranslation } from '@/i18n';

export const GitCommitSkeleton = memo(function GitCommitSkeleton() {
  const { t } = useUiTranslation('git');

  return (
    <div className="git-loading-more">
      <div className="git-skeleton-row animate-pulse">
        <div className="git-skeleton-dot" />
        <div className="git-skeleton-lines">
          <div className="git-skeleton-line-long" />
          <div className="git-skeleton-line-short" />
        </div>
        <div className="git-skeleton-hash" />
      </div>
      <div className="git-skeleton-row animate-pulse">
        <div className="git-skeleton-dot" />
        <div className="git-skeleton-lines">
          <div className="git-skeleton-line-medium" />
          <div className="git-skeleton-line-short" />
        </div>
        <div className="git-skeleton-hash" />
      </div>
      <div className="git-loading-text">
        <Loader2 className="git-spinner animate-spin" aria-hidden="true" />
        <span>{t('history.loadingMore')}</span>
      </div>
    </div>
  );
});
