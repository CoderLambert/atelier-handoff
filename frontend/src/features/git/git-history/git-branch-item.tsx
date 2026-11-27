/**
 * @file 呈现单个 Git 本地或远端分支行及其关联工作树胶囊。
 * @implementation 支持双击切换、右键菜单、选中态指示条、HEAD 标记与悬停卡片。
 * @updated 2026-11-25T12:28:00+08:00
 */
import { memo } from 'react';
import { Cloud, Folder, GitBranch as BranchIcon } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import type { GitBranch } from '@shared/git-workbench';
import { highlightMatch } from './highlight-match';

export interface GitBranchItemProps {
  branch: GitBranch;
  isSelected: boolean;
  isHead: boolean;
  worktreePath?: string;
  searchQuery: string;
  onSelect: (branch: GitBranch) => void;
  onDoubleClick?: (branch: GitBranch) => void;
  onContextMenu?: (branch: GitBranch, e: React.MouseEvent) => void;
  onMouseEnter?: (branch: GitBranch, el: HTMLElement, worktreePath?: string) => void;
  onMouseLeave?: () => void;
}

export const GitBranchItem = memo(function GitBranchItem({
  branch,
  isSelected,
  isHead,
  worktreePath,
  searchQuery,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
}: GitBranchItemProps) {
  const { t } = useUiTranslation('git');
  const isRemote = branch.kind === 'remote';

  const slashIdx = isRemote ? branch.name.indexOf('/') : -1;
  const remotePrefix = slashIdx !== -1 ? branch.name.slice(0, slashIdx + 1) : '';
  const displayName = slashIdx !== -1 ? branch.name.slice(slashIdx + 1) : branch.name;

  const folderName = worktreePath
    ? worktreePath.split('/').filter(Boolean).pop() || worktreePath
    : undefined;

  return (
    <li className="list-none p-0 m-0">
      <button
        type="button"
        className="git-branch-item-btn"
        aria-pressed={isSelected}
        title={branch.name}
        onClick={() => onSelect(branch)}
        onDoubleClick={() => onDoubleClick?.(branch)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.(branch, e);
        }}
        onMouseEnter={(e) => onMouseEnter?.(branch, e.currentTarget, worktreePath)}
        onMouseLeave={onMouseLeave}
      >
        {isSelected && <span className="git-branch-accent-bar" aria-hidden="true" />}
        <div className="git-branch-item-main">
          <span className="flex items-center gap-2 min-w-0 truncate">
            {isRemote ? (
              <Cloud className="git-branch-icon" aria-hidden="true" />
            ) : (
              <BranchIcon className="git-branch-icon" aria-hidden="true" />
            )}
            <span className="truncate">
              {remotePrefix && (
                <span className="git-remote-prefix">
                  {highlightMatch(remotePrefix, searchQuery)}
                </span>
              )}
              <span>{highlightMatch(displayName, searchQuery)}</span>
            </span>
          </span>
          {isHead && <span className="git-head-badge">{t('branch.headTag')}</span>}
        </div>
        {worktreePath && folderName && (
          <span className="git-worktree-pill" title={t('branch.occupied', { path: worktreePath })}>
            <Folder className="git-worktree-folder-icon" aria-hidden="true" />
            <span className="truncate">{folderName}</span>
          </span>
        )}
      </button>
    </li>
  );
});
