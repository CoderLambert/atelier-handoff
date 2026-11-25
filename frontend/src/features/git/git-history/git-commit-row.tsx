/**
 * @file 呈现 Git 提交时间线列表中的单个提交行。
 * @implementation 渲染时间线节点、高亮匹配信息、右键菜单与一键复制短 Hash 按钮及反馈状态。
 * @updated 2026-11-25T03:37:00+08:00
 */
import { memo } from 'react';
import { Check } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import type { GitCommit } from '@shared/git-workbench';
import { highlightMatch } from './highlight-match';

export interface GitCommitRowProps {
  commit: GitCommit;
  isSelected: boolean;
  isCopied: boolean;
  dateFormat: Intl.DateTimeFormat;
  searchHighlightQuery: string;
  onSelect: (oid: string) => void;
  onCopyHash: (e: React.MouseEvent, oid: string) => void;
  onContextMenu?: (commit: GitCommit, e: React.MouseEvent) => void;
  onMouseEnter?: (commit: GitCommit, el: HTMLElement) => void;
  onMouseLeave?: () => void;
}

export const GitCommitRow = memo(function GitCommitRow({
  commit,
  isSelected,
  isCopied,
  dateFormat,
  searchHighlightQuery,
  onSelect,
  onCopyHash,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
}: GitCommitRowProps) {
  const { t } = useUiTranslation('git');

  return (
    <li>
      <div
        className="git-commit-row"
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        onClick={() => onSelect(commit.oid)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.(commit, e);
        }}
        onMouseEnter={(e) => onMouseEnter?.(commit, e.currentTarget)}
        onMouseLeave={onMouseLeave}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect(commit.oid);
          }
        }}
      >
        <div className="git-commit-main">
          <span className="git-commit-dot" aria-hidden="true" />
          <div className="git-commit-info">
            <div className="git-commit-title" title={commit.subject}>
              {highlightMatch(commit.subject || t('history.untitled'), searchHighlightQuery)}
            </div>
            <div className="git-commit-meta">
              <span>{highlightMatch(commit.author, searchHighlightQuery)}</span>
              <span>·</span>
              <span>{dateFormat.format(new Date(commit.date))}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className={`git-commit-hash-btn ${isCopied ? 'copied' : ''}`}
          title={isCopied ? t('history.hashCopied') : t('history.copyHash')}
          onClick={(e) => onCopyHash(e, commit.oid)}
        >
          {isCopied ? (
            <>
              <Check className="git-copy-icon" aria-hidden="true" />
              <span>{commit.oid.slice(0, 8)}</span>
            </>
          ) : (
            <span>{highlightMatch(commit.oid.slice(0, 8), searchHighlightQuery)}</span>
          )}
        </button>
      </div>
    </li>
  );
});
