/**
 * @file 展示 Git 工作树 HEAD 卡片与可筛选的分组分支侧栏。
 * @implementation 组合吸顶模糊筛选、HEAD 状态卡片及本地与远端折叠分组。
 * @updated 2026-11-25T02:49:00+08:00
 */
import { useCallback, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useUiTranslation } from '@/i18n';
import type { GitBranch, GitOverview, GitWorktree } from '@shared/git-workbench';
import { GitBranchGroup } from './git-branch-group';
import { GitBranchItem } from './git-branch-item';
import { GitHeadCard } from './git-head-card';

export interface GitBranchSidebarProps {
  overview: GitOverview;
  tree: GitWorktree;
  selectedBranch?: GitBranch;
  onSelectHead: () => void;
  onSelectBranch: (branch: GitBranch) => void;
}

export function GitBranchSidebar({
  overview,
  tree,
  selectedBranch,
  onSelectHead,
  onSelectBranch,
}: GitBranchSidebarProps) {
  const { t } = useUiTranslation('git');
  const [branchQuery, setBranchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<{ local: boolean; remote: boolean }>({
    local: false,
    remote: false,
  });

  const bq = branchQuery.trim().toLowerCase();

  const localBranches = useMemo(
    () =>
      overview.branches.filter(
        (item) => item.kind === 'local' && (!bq || item.name.toLowerCase().includes(bq)),
      ),
    [overview.branches, bq],
  );

  const remoteBranches = useMemo(
    () =>
      overview.branches.filter(
        (item) => item.kind === 'remote' && (!bq || item.name.toLowerCase().includes(bq)),
      ),
    [overview.branches, bq],
  );

  const isLocalCollapsed = bq ? false : collapsedGroups.local;
  const isRemoteCollapsed = bq ? false : collapsedGroups.remote;

  const toggleLocal = useCallback(() => {
    setCollapsedGroups((prev) => ({ ...prev, local: !prev.local }));
  }, []);

  const toggleRemote = useCallback(() => {
    setCollapsedGroups((prev) => ({ ...prev, remote: !prev.remote }));
  }, []);

  const headDisplayName = tree.branch || t('worktree.detached');
  const worktreePathMap = useMemo(() => {
    const map = new Map<string, string>();
    overview.worktrees.forEach((wt) => {
      map.set(wt.id, wt.path);
    });
    return map;
  }, [overview.worktrees]);

  return (
    <div className="git-branch-sidebar">
      {/* 1. 吸顶分支即时筛选框 */}
      <div className="git-branch-search-box">
        <div className="git-search-input-wrapper">
          <Search className="git-search-icon" aria-hidden="true" />
          <input
            type="text"
            className="git-branch-search-input"
            placeholder={t('branch.searchPlaceholder')}
            value={branchQuery}
            onChange={(e) => setBranchQuery(e.target.value)}
          />
          {branchQuery && (
            <button
              type="button"
              className="git-clear-btn"
              title={t('branch.searchClear')}
              onClick={() => setBranchQuery('')}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* 2. 工作树 HEAD 固定状态卡片 */}
      <GitHeadCard
        branchName={headDisplayName}
        headOid={tree.head}
        isActive={!selectedBranch}
        onSelect={onSelectHead}
      />

      {/* 3. 可折叠分支列表 */}
      <div className="git-branch-list-scroll">
        {localBranches.length === 0 && remoteBranches.length === 0 ? (
          <div className="git-empty-branches">
            <p className="git-empty-title">{t('branch.notFound')}</p>
            <p className="git-empty-desc">{t('branch.notFoundHint')}</p>
          </div>
        ) : (
          <>
            {overview.branches.some((b) => b.kind === 'local') && (
              <GitBranchGroup
                title={t('branch.local')}
                count={localBranches.length}
                isCollapsed={isLocalCollapsed}
                onToggleCollapse={toggleLocal}
              >
                {localBranches.map((item) => (
                  <GitBranchItem
                    key={item.name}
                    branch={item}
                    isSelected={selectedBranch?.kind === 'local' && selectedBranch.name === item.name}
                    isHead={item.oid === tree.head || item.name === tree.branch}
                    worktreePath={item.worktreeId ? worktreePathMap.get(item.worktreeId) : undefined}
                    searchQuery={branchQuery}
                    onSelect={onSelectBranch}
                  />
                ))}
              </GitBranchGroup>
            )}

            {overview.branches.some((b) => b.kind === 'remote') && (
              <div className="mt-2">
                <GitBranchGroup
                  title={t('branch.remote')}
                  count={remoteBranches.length}
                  isCollapsed={isRemoteCollapsed}
                  onToggleCollapse={toggleRemote}
                >
                  {remoteBranches.map((item) => (
                    <GitBranchItem
                      key={item.name}
                      branch={item}
                      isSelected={selectedBranch?.kind === 'remote' && selectedBranch.name === item.name}
                      isHead={item.oid === tree.head || item.name === tree.branch}
                      searchQuery={branchQuery}
                      onSelect={onSelectBranch}
                    />
                  ))}
                </GitBranchGroup>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
