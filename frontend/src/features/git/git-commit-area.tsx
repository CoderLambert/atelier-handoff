/**
 * @file 提供文件变动页面的提交操作区，包含 Amend 修改上次提交与 Undo 撤回提交。
 * @implementation 通过桌面桥提交现有暂存内容，支持 Amend 回填和确认后软重置撤回上次提交。
 * @updated 2026-11-25T13:37:46+08:00
 */
import { useEffect, useState } from 'react';
import { GitCommitHorizontal, RotateCcw } from 'lucide-react';
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
import { getDesktopGitBridge } from '@/desktop-git';
import { Textarea } from '@/components/ui/textarea';

export interface GitCommitAreaProps {
  cwd?: string;
  disabled?: boolean;
  stagedCount: number;
  onBusy: (value: boolean) => void;
  onRefreshAll?: () => Promise<void>;
  showToast?: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitCommitArea({
  cwd,
  disabled,
  stagedCount,
  onBusy,
  onRefreshAll,
  showToast,
}: GitCommitAreaProps) {
  const { t } = useUiTranslation('git');
  const [message, setMessage] = useState('');
  const [isAmend, setIsAmend] = useState(false);
  const [loading, setLoading] = useState(false);
  const [undoModalOpen, setUndoModalOpen] = useState(false);
  const unavailable = disabled || loading || !cwd || !getDesktopGitBridge();
  const commitDisabled = unavailable || (!isAmend && stagedCount === 0) || !message.trim();

  // 当勾选 Amend 时，自动拉取最近一次提交的 Message 并回填
  useEffect(() => {
    if (!isAmend || !cwd) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    void (async () => {
      try {
        const stats = await bridge.getCommitStats(cwd, 'HEAD');
        if (stats && stats.body) {
          setMessage(stats.body.trim());
        }
      } catch {
        // 忽略静默失败
      }
    })();
  }, [isAmend, cwd]);

  // 执行提交操作
  const handleCommit = async () => {
    const trimmed = message.trim();
    if (commitDisabled || !cwd) return;

    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setLoading(true);
    onBusy(true);
    try {
      const res = isAmend
        ? await bridge.amendCommit(cwd, trimmed)
        : await bridge.commit(cwd, trimmed);

      if (!res.success) {
        showToast?.(t('commit.quickFailed'), 'error', res.stderr);
        return;
      }

      showToast?.(t(isAmend ? 'commit.quickAmended' : 'commit.quickCreated'), 'success');
      setMessage('');
      setIsAmend(false);
      await onRefreshAll?.();
    } catch (err) {
      showToast?.(
        t('commit.quickFailed'),
        'error',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setLoading(false);
      onBusy(false);
    }
  };

  // 执行撤回上次提交 (git reset --soft HEAD~1)
  const handleUndoCommit = async () => {
    if (unavailable || !cwd) return;
    const bridge = getDesktopGitBridge();
    if (!bridge) return;

    setLoading(true);
    onBusy(true);
    try {
      const res = await bridge.reset(cwd, 'HEAD~1', 'soft');
      if (!res.success) {
        showToast?.('撤回提交失败', 'error', res.stderr);
        return;
      }
      showToast?.('已撤回上次提交，改动已保留至暂存区', 'success');
      setUndoModalOpen(false);
      await onRefreshAll?.();
    } catch (err) {
      showToast?.('撤回提交异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      onBusy(false);
    }
  };

  return (
    <div className="shrink-0 p-3 border-t border-border bg-card/60 space-y-2">
      <Textarea
        rows={3}
        value={message}
        disabled={disabled || loading}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (!e.nativeEvent.isComposing && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void handleCommit();
          }
        }}
        aria-label={t('commit.quickMessage')}
        placeholder={t('commit.inputPlaceholder')}
        className="w-full p-2 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring resize-none placeholder:text-muted-foreground"
      />

      <div className="flex items-center justify-between text-xs">
        <label className="inline-flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground select-none">
          <input
            type="checkbox"
            checked={isAmend}
            disabled={disabled || loading}
            onChange={(e) => setIsAmend(e.target.checked)}
            className="rounded border-input text-primary"
          />
          <span>{t('files.amend')}</span>
        </label>

        <button
          type="button"
          disabled={disabled || loading}
          onClick={() => setUndoModalOpen(true)}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors flex items-center gap-1"
          title={t('commit.undoHint')}
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          <span>{t('files.undoCommit')}</span>
        </button>
      </div>

      <Button
        type="button"
        size="sm"
        disabled={commitDisabled}
        title={stagedCount === 0 && !isAmend ? t('commit.quickEmpty') : undefined}
        onClick={() => void handleCommit()}
        className="w-full h-8 text-xs font-medium"
      >
        <GitCommitHorizontal className="w-3.5 h-3.5 mr-1" aria-hidden="true" />
        <span>
          {loading
            ? t('commit.committing')
            : isAmend
              ? t('commit.amendSubmit')
              : t('commit.submit')}
        </span>
      </Button>

      {/* 撤回提交确认弹窗 */}
      <Dialog open={undoModalOpen} onOpenChange={(o) => !loading && setUndoModalOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="w-4 h-4" aria-hidden="true" />
              <span>{t('files.undoCommitConfirmTitle')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs pt-2 leading-relaxed">
              {t('files.undoCommitConfirmDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setUndoModalOpen(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={loading}
              onClick={() => void handleUndoCommit()}
            >
              {loading ? t('commit.undoing') : t('commit.undoSubmit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
