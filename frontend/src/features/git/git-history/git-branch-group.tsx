/**
 * @file 展示可折叠的 Git 本地或远端分支分组列表。
 * @implementation 提供带折叠指示箭头与数量角标的标题按钮，并渲染分支子项。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { memo } from 'react';
import { ChevronDown } from 'lucide-react';

export interface GitBranchGroupProps {
  title: string;
  count: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  children: React.ReactNode;
}

export const GitBranchGroup = memo(function GitBranchGroup({
  title,
  count,
  isCollapsed,
  onToggleCollapse,
  children,
}: GitBranchGroupProps) {
  return (
    <div className="git-branch-group">
      <button
        type="button"
        className="git-group-header-btn"
        aria-expanded={!isCollapsed}
        onClick={onToggleCollapse}
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown
            className={`git-group-chevron ${isCollapsed ? 'collapsed' : ''}`}
            aria-hidden="true"
          />
          <span>{title}</span>
        </span>
        <span className="git-group-badge">{count}</span>
      </button>
      {!isCollapsed && <ul className="mt-1 space-y-0.5">{children}</ul>}
    </div>
  );
});
