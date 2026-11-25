/**
 * @file 提供顶部工具栏的智能远端同步组合按钮与操作菜单。
 * @implementation 动态计算上游及 ahead/behind 状态，处理脏工作区自动暂存拦截与强制推送二次确认。
 * @updated 2026-11-25T03:30:00+08:00
 */
import { useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  CloudUpload,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useUiTranslation } from '@/i18n';
import { desktopGitBridge } from '@/desktop-git';
import type { GitRepoStatus } from '@shared/desktop-git';

export interface GitSyncButtonProps {
  cwd?: string;
  status: GitRepoStatus | null;
  onRefreshAll: () => void;
  showToast: (message: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitSyncButton({
  cwd,
  status,
  onRefreshAll,
  showToast,
}: GitSyncButtonProps) {
  const { t } = useUiTranslation('git');
  const [isSyncing, setIsSyncing] = useState(false);
  const [showForcePushDialog, setShowForcePushDialog] = useState(false);
  const [autoStashAction, setAutoStashAction] = useState<'pull' | 'sync' | 'pull-rebase' | null>(null);

  const bridge = desktopGitBridge();

  const upstream = status?.upstream;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const isDirty = Boolean(status?.isDirty);

  // 1. 计算主按钮文案与图标
  let mainLabel: string = t('sync.fetch');
  let MainIcon = RefreshCw;
  if (!upstream) {
    mainLabel = t('sync.publish');
    MainIcon = CloudUpload;
  } else if (ahead > 0 && behind > 0) {
    mainLabel = t('sync.sync', { ahead, behind });
    MainIcon = RefreshCw;
  } else if (behind > 0) {
    mainLabel = t('sync.pull', { count: behind });
    MainIcon = ArrowDown;
  } else if (ahead > 0) {
    mainLabel = t('sync.push', { count: ahead });
    MainIcon = ArrowUp;
  }

  // 执行核心同步操作
  const runOperation = async (action: 'publish' | 'fetch' | 'pull' | 'pull-rebase' | 'push' | 'sync' | 'force-push') => {
    if (!bridge || !cwd || isSyncing) return;
    setIsSyncing(true);

    try {
      if (action === 'publish') {
        const res = await bridge.push(cwd, {
          setUpstream: true,
          remote: 'origin',
          branch: status?.currentBranch || 'HEAD',
        });
        if (res.success) {
          showToast(`已成功发布分支至 origin/${status?.currentBranch}`, 'success');
          onRefreshAll();
        } else {
          showToast('发布分支失败', 'error', res.stderr);
        }
      } else if (action === 'fetch') {
        const res = await bridge.fetch(cwd);
        if (res.success) {
          showToast('已成功获取全部远端最新引用', 'success');
          onRefreshAll();
        } else {
          showToast('获取远端更新失败', 'error', res.stderr);
        }
      } else if (action === 'pull') {
        const res = await bridge.pull(cwd);
        if (res.success) {
          showToast('已拉取远端更新', 'success');
          onRefreshAll();
        } else {
          showToast('拉取失败', 'error', res.stderr);
        }
      } else if (action === 'pull-rebase') {
        const res = await bridge.pull(cwd, { rebase: true });
        if (res.success) {
          showToast('已变基拉取远端更新', 'success');
          onRefreshAll();
        } else {
          showToast('变基拉取失败', 'error', res.stderr);
        }
      } else if (action === 'push') {
        const res = await bridge.push(cwd);
        if (res.success) {
          showToast(`已推送 ${ahead || 1} 个提交至远端`, 'success');
          onRefreshAll();
        } else {
          showToast('推送失败', 'error', res.stderr);
        }
      } else if (action === 'sync') {
        const pullRes = await bridge.pull(cwd);
        if (!pullRes.success) {
          showToast('同步时拉取远端失败', 'error', pullRes.stderr);
          return;
        }
        const pushRes = await bridge.push(cwd);
        if (pushRes.success) {
          showToast('已与远端完全同步', 'success');
          onRefreshAll();
        } else {
          showToast('同步时推送至远端失败', 'error', pushRes.stderr);
        }
      } else if (action === 'force-push') {
        const res = await bridge.push(cwd, { forceWithLease: true });
        if (res.success) {
          showToast('已成功执行强制推送 (--force-with-lease)', 'success');
          onRefreshAll();
        } else {
          showToast('强制推送失败', 'error', res.stderr);
        }
      }
    } catch (err) {
      showToast('Git 操作执行异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSyncing(false);
    }
  };

  const handlePrimaryClick = () => {
    if (!upstream) {
      void runOperation('publish');
      return;
    }
    if (behind > 0 || ahead > 0) {
      const isPullOrSync = (ahead > 0 && behind > 0) || behind > 0;
      if (isPullOrSync && isDirty) {
        setAutoStashAction(ahead > 0 && behind > 0 ? 'sync' : 'pull');
        return;
      }
      if (ahead > 0 && behind > 0) {
        void runOperation('sync');
      } else if (behind > 0) {
        void runOperation('pull');
      } else {
        void runOperation('push');
      }
      return;
    }
    void runOperation('fetch');
  };

  const handleAutoStashConfirm = async () => {
    if (!autoStashAction || !bridge || !cwd) return;
    const action = autoStashAction;
    setAutoStashAction(null);
    setIsSyncing(true);

    try {
      if (action === 'pull') {
        const res = await bridge.checkoutBranch(cwd, status?.currentBranch || 'HEAD', true);
        if (!res.success) {
          showToast('自动暂存并拉取失败', 'error', res.stderr);
          return;
        }
        const pullRes = await bridge.pull(cwd, { autoStash: true });
        if (pullRes.success) {
          showToast('已自动暂存、拉取并恢复改动', 'success');
          onRefreshAll();
        } else {
          showToast('拉取更新失败', 'error', pullRes.stderr);
        }
      } else if (action === 'sync') {
        const pullRes = await bridge.pull(cwd, { autoStash: true });
        if (!pullRes.success) {
          showToast('自动暂存并同步失败', 'error', pullRes.stderr);
          return;
        }
        const pushRes = await bridge.push(cwd);
        if (pushRes.success) {
          showToast('已自动暂存、同步并恢复改动', 'success');
          onRefreshAll();
        } else {
          showToast('同步推送失败', 'error', pushRes.stderr);
        }
      }
    } catch (err) {
      showToast('自动暂存执行异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <>
      <div className="inline-flex items-center rounded-md border border-border bg-card shadow-xs">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5 text-xs font-medium rounded-r-none border-r border-border hover:bg-accent"
          disabled={!bridge || !cwd || isSyncing}
          onClick={handlePrimaryClick}
        >
          {isSyncing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" aria-hidden="true" />
          ) : (
            <MainIcon className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" />
          )}
          <span>{isSyncing ? t('sync.syncing') : mainLabel}</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 rounded-l-none hover:bg-accent"
              disabled={!bridge || !cwd || isSyncing}
              aria-label={t('sync.moreOptions')}
            >
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => void runOperation('fetch')}>
              <RefreshCw className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              <span>{t('sync.fetchAll')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (isDirty) setAutoStashAction('pull');
                else void runOperation('pull');
              }}
            >
              <ArrowDown className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              <span>{t('sync.pullOnly')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                if (isDirty) setAutoStashAction('pull-rebase');
                else void runOperation('pull-rebase');
              }}
            >
              <ArrowDown className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              <span>{t('sync.pullRebase')}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void runOperation('push')}>
              <ArrowUp className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              <span>{t('sync.pushOnly')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive focus:bg-destructive/10"
              onClick={() => setShowForcePushDialog(true)}
            >
              <AlertTriangle className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              <span>{t('sync.forcePush')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 强制推送二次确认对话框 */}
      {showForcePushDialog && (
        <Dialog open onOpenChange={setShowForcePushDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                <span>{t('sync.forcePushConfirmTitle')}</span>
              </DialogTitle>
              <DialogDescription className="pt-2 text-xs leading-relaxed">
                {t('sync.forcePushConfirmDesc')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowForcePushDialog(false)}
              >
                {t('board.close')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  setShowForcePushDialog(false);
                  void runOperation('force-push');
                }}
              >
                {t('sync.forcePush')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* 脏工作区自动暂存并拉取确认对话框 */}
      {autoStashAction && (
        <Dialog open onOpenChange={(open) => !open && setAutoStashAction(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 git-dialog-warning-icon" aria-hidden="true" />
                <span>{t('sync.autoStashTitle')}</span>
              </DialogTitle>
              <DialogDescription className="pt-2 text-xs leading-relaxed">
                {t('sync.autoStashDesc')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAutoStashAction(null)}
              >
                {t('board.close')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleAutoStashConfirm()}
              >
                {t('sync.autoStashButton')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
