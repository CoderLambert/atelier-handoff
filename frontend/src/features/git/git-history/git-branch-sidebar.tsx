/**
 * @file 展示 Git 工作树 HEAD 卡片与可筛选的分组分支侧栏。
 * @implementation 按本地和远端分组分支，确认时标明来源与工作树目标，将合并结果反馈给用户。
 * @updated 2026-11-27T01:02:41+08:00
 */
import { useCallback, useMemo, useState } from 'react';
import { Plus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUiTranslation } from '@/i18n';
import type { GitBranch, GitOverview, GitWorktree } from '@shared/git-workbench';
import type { GitMergeRequest, GitRepoStatus } from '@shared/desktop-git';
import { getDesktopGitBridge } from '@/desktop-git';
import { GitContextMenu, type GitContextMenuItem } from '../git-context-menu';
import {
  GitCheckoutDirtyModal,
  GitDeleteBranchModal,
  GitRenameBranchModal,
} from '../git-branch-dialogs';
import { GitBranchGroup } from './git-branch-group';
import { GitBranchItem } from './git-branch-item';
import { GitHeadCard } from './git-head-card';
import { useHoverCard } from './use-hover-card';
import { GitBranchHoverCard } from './git-branch-hover-card';

interface HoveredBranchData {
  branch: GitBranch;
  worktreePath?: string;
}

export interface GitBranchSidebarProps {
  overview: GitOverview;
  tree: GitWorktree;
  selectedBranch?: GitBranch;
  repoStatus?: GitRepoStatus | null;
  onSelectHead: () => void;
  onSelectBranch: (branch: GitBranch) => void;
  onRefreshAll?: () => void;
  showToast?: (message: string, type?: 'success' | 'error', stderr?: string) => void;
  onOpenCreateBranch?: (startPoint?: string) => void;
}

export function GitBranchSidebar({
  overview,
  tree,
  selectedBranch,
  repoStatus,
  onSelectHead,
  onSelectBranch,
  onRefreshAll,
  showToast,
  onOpenCreateBranch,
}: GitBranchSidebarProps) {
  const { t } = useUiTranslation('git');
  const [branchQuery, setBranchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<{ local: boolean; remote: boolean }>({
    local: false,
    remote: false,
  });

  // 分支操作弹窗状态
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: GitContextMenuItem[];
  } | null>(null);
  const [renameBranch, setRenameBranch] = useState<string | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<string | null>(null);
  const [dirtyCheckoutBranch, setDirtyCheckoutBranch] = useState<string | null>(null);
  const [mergeRequest, setMergeRequest] = useState<GitMergeRequest | null>(null);
  const [merging, setMerging] = useState(false);

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

  const { activeItem, handleMouseEnter, handleMouseLeave, handleScroll } =
    useHoverCard<HoveredBranchData>(400);

  const onBranchEnter = useCallback(
    (branch: GitBranch, el: HTMLElement, wtPath?: string) => {
      handleMouseEnter({ branch, worktreePath: wtPath }, el);
    },
    [handleMouseEnter],
  );

  // 双击分支检出切换
  const handleDoubleClickBranch = useCallback(
    (branch: GitBranch) => {
      if (branch.kind !== 'local') return;
      if (branch.name === tree.branch) return;

      const bridge = getDesktopGitBridge();
      if (!bridge || !tree.path) return;

      if (repoStatus?.isDirty) {
        setDirtyCheckoutBranch(branch.name);
      } else {
        void (async () => {
          try {
            const res = await bridge.checkoutBranch(tree.path, branch.name, false);
            if (!res.success) {
              showToast?.('切换分支失败', 'error', res.stderr);
              return;
            }
            showToast?.(`已切换到分支 ${branch.name}`, 'success');
            onRefreshAll?.();
          } catch (err) {
            showToast?.('切换分支异常', 'error', err instanceof Error ? err.message : String(err));
          }
        })();
      }
    },
    [tree.branch, tree.path, repoStatus?.isDirty, showToast, onRefreshAll],
  );

  // 右键弹出分支操作菜单
  const handleContextMenuBranch = useCallback(
    (branch: GitBranch, e: React.MouseEvent) => {
      const isHead = branch.kind === 'local' && branch.name === tree.branch;
      const bridge = getDesktopGitBridge();
      if (!bridge || !tree.path) return;
      const mergeIntoWorktree = () =>
        setMergeRequest({
          cwd: tree.path,
          source: { kind: branch.kind, name: branch.name },
          targetBranch: tree.branch,
        });

      if (branch.kind === 'local') {
        const items: GitContextMenuItem[] = [
          {
            label: t('branch.contextSwitch'),
            disabled: isHead,
            onClick: () => handleDoubleClickBranch(branch),
          },
          {
            label: t('branch.contextMerge'),
            disabled: isHead,
            onClick: mergeIntoWorktree,
          },
          {
            label: t('branch.contextRename'),
            onClick: () => setRenameBranch(branch.name),
          },
          { divider: true, label: '' },
          {
            label: t('branch.contextDelete'),
            disabled: isHead,
            danger: true,
            onClick: () => setDeleteBranch(branch.name),
          },
        ];
        setContextMenu({ x: e.clientX, y: e.clientY, items });
      } else {
        const localTargetName = branch.name.replace(/^[^\/]+\//, '');
        const items: GitContextMenuItem[] = [
          {
            label: t('branch.contextCheckoutRemote'),
            onClick: () => {
              void (async () => {
                const res = await bridge.checkoutBranch(tree.path, localTargetName, false);
                if (!res.success) {
                  showToast?.('检出分支失败', 'error', res.stderr);
                  return;
                }
                showToast?.(`已检出分支 ${localTargetName}`, 'success');
                onRefreshAll?.();
              })();
            },
          },
          {
            label: t('branch.contextMerge'),
            onClick: mergeIntoWorktree,
          },
        ];
        setContextMenu({ x: e.clientX, y: e.clientY, items });
      }
    },
    [tree.branch, tree.path, t, handleDoubleClickBranch, showToast, onRefreshAll],
  );

  const mergeTargetName = mergeRequest?.targetBranch ?? t('worktree.detached');

  // 执行合并操作
  const handleConfirmMerge = async () => {
    if (!mergeRequest || merging) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setMerging(true);
    try {
      const res = await bridge.mergeBranch(mergeRequest);
      const branches = { name: mergeRequest.source.name, target: mergeTargetName };
      switch (res.status) {
        case 'merged':
          showToast?.(t('branch.mergeDone', branches));
          break;
        case 'upToDate':
          showToast?.(t('branch.mergeUpToDate', branches));
          break;
        case 'targetChanged':
          showToast?.(t('branch.mergeTargetChanged'), 'error');
          break;
        case 'failed':
          showToast?.(t('branch.mergeFailed'), 'error', res.stderr || res.stdout);
          break;
      }
      onRefreshAll?.();
    } catch (err) {
      showToast?.(t('branch.mergeFailed'), 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
      setMergeRequest(null);
    }
  };

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
              className="git-search-clear-btn"
              onClick={() => setBranchQuery('')}
              aria-label={t('branch.searchClear')}
            >
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* 2. HEAD 状态卡片 */}
      <GitHeadCard
        branchName={headDisplayName}
        headOid={tree.head}
        isActive={!selectedBranch}
        onSelect={onSelectHead}
      />

      {/* 3. 可折叠分支列表 */}
      <div className="git-branch-list-scroll" onScroll={handleScroll}>
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
                action={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenCreateBranch?.();
                    }}
                    aria-label={t('branch.newBranch')}
                    title={t('branch.newBranch')}
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                  </Button>
                }
              >
                {localBranches.map((item) => (
                  <GitBranchItem
                    key={item.name}
                    branch={item}
                    isSelected={selectedBranch?.kind === 'local' && selectedBranch.name === item.name}
                    isHead={item.name === tree.branch}
                    worktreePath={item.worktreeId ? worktreePathMap.get(item.worktreeId) : undefined}
                    searchQuery={branchQuery}
                    onSelect={onSelectBranch}
                    onDoubleClick={handleDoubleClickBranch}
                    onContextMenu={handleContextMenuBranch}
                    onMouseEnter={onBranchEnter}
                    onMouseLeave={handleMouseLeave}
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
                      isHead={false}
                      searchQuery={branchQuery}
                      onSelect={onSelectBranch}
                      onDoubleClick={handleDoubleClickBranch}
                      onContextMenu={handleContextMenuBranch}
                      onMouseEnter={onBranchEnter}
                      onMouseLeave={handleMouseLeave}
                    />
                  ))}
                </GitBranchGroup>
              </div>
            )}
          </>
        )}
      </div>

      {activeItem && (
        <GitBranchHoverCard
          branch={activeItem.item.branch}
          rect={activeItem.rect}
          worktreePath={activeItem.item.worktreePath}
        />
      )}

      {/* 右键上下文菜单 */}
      {contextMenu && (
        <GitContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* 分支重命名对话框 */}
      {renameBranch && (
        <GitRenameBranchModal
          open
          onOpenChange={(o) => !o && setRenameBranch(null)}
          cwd={tree.path}
          oldName={renameBranch}
          onSuccess={() => onRefreshAll?.()}
          showToast={showToast ?? (() => {})}
        />
      )}

      {/* 分支删除确认对话框 */}
      {deleteBranch && (
        <GitDeleteBranchModal
          open
          onOpenChange={(o) => !o && setDeleteBranch(null)}
          cwd={tree.path}
          branchName={deleteBranch}
          onSuccess={() => onRefreshAll?.()}
          showToast={showToast ?? (() => {})}
        />
      )}

      {/* 脏工作区检出确认对话框 */}
      {dirtyCheckoutBranch && (
        <GitCheckoutDirtyModal
          open
          onOpenChange={(o) => !o && setDirtyCheckoutBranch(null)}
          cwd={tree.path}
          targetBranch={dirtyCheckoutBranch}
          onSuccess={() => onRefreshAll?.()}
          showToast={showToast ?? (() => {})}
        />
      )}

      {/* 合并分支确认对话框 */}
      {mergeRequest && (
        <Dialog open onOpenChange={(o) => !merging && !o && setMergeRequest(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('branch.mergeConfirmTitle')}</DialogTitle>
              <DialogDescription className="text-xs pt-2">
                {t('branch.mergeConfirmDesc', {
                  name: mergeRequest.source.name,
                  target: mergeTargetName,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={merging}
                onClick={() => setMergeRequest(null)}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={merging}
                onClick={() => void handleConfirmMerge()}
              >
                {merging ? t('branch.merging') : t('branch.mergeSubmit')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
