/**
 * @file 展示分支列表项的右侧弹出悬停信息卡片。
 * @implementation 经由 Portal 挂载以防容器裁切，展示完整分支名、远端同步状态、工作树绝对路径与最新提交摘要。
 * @updated 2026-11-25T03:25:00+08:00
 */
import { createPortal } from 'react-dom';
import { Cloud, Folder, GitBranch as BranchIcon, GitCommitHorizontal } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import type { GitBranch } from '@shared/git-workbench';

export interface GitBranchHoverCardProps {
  branch: GitBranch;
  rect: DOMRect;
  worktreePath?: string;
  ahead?: number;
  behind?: number;
}

export function GitBranchHoverCard({
  branch,
  rect,
  worktreePath,
  ahead,
  behind,
}: GitBranchHoverCardProps) {
  const { t } = useUiTranslation('git');
  const isRemote = branch.kind === 'remote';

  const cardWidth = 320;
  const estimatedHeight = 150;
  const spaceRight =
    typeof window !== 'undefined' ? window.innerWidth - rect.right : 400;
  const showLeft = spaceRight < cardWidth + 16 && rect.left > cardWidth + 16;

  const left = showLeft ? rect.left - cardWidth - 8 : rect.right + 8;
  const top =
    typeof window !== 'undefined'
      ? Math.max(12, Math.min(rect.top, window.innerHeight - estimatedHeight - 12))
      : rect.top;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="git-hover-card-portal git-branch-hover-card"
      style={{
        position: 'fixed',
        top: `${top}px`,
        left: `${left}px`,
        width: `${cardWidth}px`,
        zIndex: 9999,
      }}
      role="tooltip"
    >
      <div className="git-card-header">
        <span className="flex items-center gap-1.5 min-w-0 font-medium text-[13px] truncate">
          {isRemote ? (
            <Cloud className="w-4 h-4 git-card-branch-remote shrink-0" aria-hidden="true" />
          ) : (
            <BranchIcon className="w-4 h-4 git-card-branch-local shrink-0" aria-hidden="true" />
          )}
          <span className="truncate" title={branch.name}>{branch.name}</span>
        </span>
      </div>

      {/* 与远端同步状态 */}
      <div className="git-card-section">
        <span className="git-card-label">{t('card.syncStatus')}:</span>
        <span className="git-card-value font-mono">
          {ahead !== undefined && behind !== undefined ? (
            ahead === 0 && behind === 0 ? (
              <span className="git-card-synced">{t('card.synced')}</span>
            ) : (
              <span>{t('card.aheadBehind', { ahead, behind })}</span>
            )
          ) : (
            <span className="text-muted-foreground">{t('card.noUpstream')}</span>
          )}
        </span>
      </div>

      {/* 工作树完整绝对路径（如有） */}
      {worktreePath && (
        <div className="git-card-section">
          <span className="git-card-label flex items-center gap-1">
            <Folder className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('card.worktreePath')}:</span>
          </span>
          <div className="git-card-path font-mono text-[11px]" title={worktreePath}>
            {worktreePath}
          </div>
        </div>
      )}

      {/* 最近一条提交摘要 */}
      <div className="git-card-section">
        <span className="git-card-label flex items-center gap-1">
          <GitCommitHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t('card.latestCommit')}:</span>
        </span>
        <span className="git-card-value font-mono text-[11px] text-muted-foreground">
          {branch.oid.slice(0, 10)}
        </span>
      </div>
    </div>,
    document.body,
  );
}
