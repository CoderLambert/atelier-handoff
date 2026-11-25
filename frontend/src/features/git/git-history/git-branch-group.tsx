/**
 * @file 展示可折叠的 Git 本地或远端分支分组列表。
 * @implementation 提供带折叠指示箭头、操作插槽与数量角标的标题区域，并渲染分支子项。
 * @updated 2026-11-25T12:28:00+08:00
 */
import { memo } from 'react';
import { ChevronDown } from 'lucide-react';

export interface GitBranchGroupProps {
  title: string;
  count: number;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
}

export const GitBranchGroup = memo(function GitBranchGroup({
  title,
  count,
  isCollapsed,
  onToggleCollapse,
  action,
  children,
}: GitBranchGroupProps) {
  return (
    <div className="git-branch-group">
      <div className="flex items-center justify-between pr-1">
        <button
          type="button"
          className="git-group-header-btn flex-1"
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
        {action}
      </div>
      {!isCollapsed && <ul className="mt-1 space-y-0.5 list-none p-0 m-0">{children}</ul>}
    </div>
  );
});
