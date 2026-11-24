/**
 * @file 展示 Git 当前工作树检出状态与基准提交卡片。
 * @implementation 以紧凑状态卡片呈现检出分支与短 SHA，支持一键切换到当前 HEAD 视图。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { memo } from 'react';
import { GitBranch as BranchIcon } from 'lucide-react';
import { useUiTranslation } from '@/i18n';

export interface GitHeadCardProps {
  branchName: string;
  headOid?: string | null;
  isActive: boolean;
  onSelect: () => void;
}

export const GitHeadCard = memo(function GitHeadCard({
  branchName,
  headOid,
  isActive,
  onSelect,
}: GitHeadCardProps) {
  const { t } = useUiTranslation('git');
  const headOidShort = headOid ? headOid.slice(0, 8) : '';

  return (
    <div className="git-head-card-container">
      <button
        type="button"
        className="git-head-card"
        aria-pressed={isActive}
        onClick={onSelect}
      >
        <div className="git-head-card-header">
          <span className="git-head-card-title">
            <BranchIcon size={14} aria-hidden="true" />
            {t('branch.head')}
          </span>
          <span className="git-head-status-tag">
            <span className="git-status-dot-breathing" aria-hidden="true" />
            {t('branch.checkedOut')}
          </span>
        </div>
        <div className="git-head-card-details">
          <span className="git-head-branch-name" title={branchName}>
            {branchName}
          </span>
          {headOidShort && <span className="git-head-commit-oid">{headOidShort}</span>}
        </div>
      </button>
    </div>
  );
});
