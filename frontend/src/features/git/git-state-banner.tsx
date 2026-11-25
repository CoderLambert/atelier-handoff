/**
 * @file 展示 Git 仓库异常状态（合并/变基/摘取冲突与游离 HEAD）的全局操作横幅。
 * @implementation 条件渲染于 Tab 栏下方，提供冲突文件跳转、继续与中止，以及游离 HEAD 状态的一键开新分支。
 * @updated 2026-11-25T03:30:00+08:00
 */
import { AlertCircle, ArrowRight, GitBranch, GitMerge, Loader2, StopCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useUiTranslation } from '@/i18n';
import { desktopGitBridge } from '@/desktop-git';
import type { GitRepoStatus } from '@shared/desktop-git';

export interface GitStateBannerProps {
  cwd?: string;
  status: GitRepoStatus | null;
  onViewConflicts: () => void;
  onRefreshAll: () => void;
  showToast: (message: string, type?: 'success' | 'error', stderr?: string) => void;
  onCreateBranch?: (startPoint?: string) => void;
}

export function GitStateBanner({
  cwd,
  status,
  onViewConflicts,
  onRefreshAll,
  showToast,
  onCreateBranch,
}: GitStateBannerProps) {
  const { t } = useUiTranslation('git');
  const [loadingAction, setLoadingAction] = useState<'continue' | 'abort' | null>(null);

  if (!status || status.repoState === 'NORMAL') {
    return null;
  }

  const bridge = desktopGitBridge();
  const repoState = status.repoState;
  const conflictCount = status.conflictFiles.length;

  const handleContinue = async () => {
    if (!bridge || !cwd || loadingAction) return;
    setLoadingAction('continue');
    try {
      const res = await bridge.continueOp(cwd);
      if (res.success) {
        showToast('已成功继续操作', 'success');
        onRefreshAll();
      } else {
        showToast('继续操作未完成', 'error', res.stderr);
      }
    } catch (err) {
      showToast('继续操作异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAction(null);
    }
  };

  const handleAbort = async () => {
    if (!bridge || !cwd || loadingAction) return;
    setLoadingAction('abort');
    try {
      const res = await bridge.abortOp(cwd);
      if (res.success) {
        showToast('已中止操作，仓库状态已恢复正常', 'success');
        onRefreshAll();
      } else {
        showToast('中止操作失败', 'error', res.stderr);
      }
    } catch (err) {
      showToast('中止操作异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAction(null);
    }
  };

  if (repoState === 'DETACHED') {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-2 text-xs git-banner-detached">
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle className="w-4 h-4 shrink-0 git-banner-detached-icon" aria-hidden="true" />
          <span className="font-medium text-foreground truncate">
            {t('banner.detached')} (<code>{status.currentBranch}</code>)
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs font-medium shrink-0 git-banner-detached-btn"
          onClick={() => onCreateBranch?.(status.currentBranch)}
        >
          <GitBranch className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
          <span>{t('banner.createBranch')}</span>
        </Button>
      </div>
    );
  }

  const stateName =
    repoState === 'MERGING'
      ? t('banner.merging')
      : repoState === 'REBASING'
        ? t('banner.rebasing')
        : t('banner.cherryPicking');

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-destructive/40 bg-destructive/10 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <GitMerge className="w-4 h-4 text-destructive shrink-0" aria-hidden="true" />
        <span className="font-semibold text-destructive">{stateName}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-medium text-foreground">
          {t('banner.conflicts', { count: conflictCount })}
        </span>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs font-medium hover:bg-destructive/15 text-destructive"
          onClick={onViewConflicts}
        >
          <span>{t('banner.viewConflicts')}</span>
          <ArrowRight className="w-3 h-3 ml-1" aria-hidden="true" />
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs font-medium"
          disabled={loadingAction !== null}
          onClick={() => void handleContinue()}
        >
          {loadingAction === 'continue' ? (
            <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden="true" />
          ) : null}
          <span>{t('banner.continue')}</span>
        </Button>

        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="h-6 px-2 text-xs font-medium"
          disabled={loadingAction !== null}
          onClick={() => void handleAbort()}
        >
          {loadingAction === 'abort' ? (
            <Loader2 className="w-3 h-3 animate-spin mr-1" aria-hidden="true" />
          ) : (
            <StopCircle className="w-3 h-3 mr-1" aria-hidden="true" />
          )}
          <span>{t('banner.abort')}</span>
        </Button>
      </div>
    </div>
  );
}
