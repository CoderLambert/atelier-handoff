/**
 * @file 提供针对历史提交的 Reset 回退、Revert 撤销与 Cherry-pick 摘取对话框。
 * @implementation 支持 Soft/Mixed/Hard 单选及 Hard 危险红色警告提示，二次确认执行 Git 回退与变动应用。
 * @updated 2026-11-25T03:36:00+08:00
 */
import { useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
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

export interface GitResetModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd?: string;
  commitHash: string;
  commitSubject?: string;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitResetModal({
  open,
  onOpenChange,
  cwd,
  commitHash,
  commitSubject,
  onSuccess,
  showToast,
}: GitResetModalProps) {
  const { t } = useUiTranslation('git');
  const [mode, setMode] = useState<'soft' | 'mixed' | 'hard'>('soft');
  const [hardConfirmed, setHardConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleReset = async () => {
    const bridge = getDesktopGitBridge();
    if (!bridge || !cwd) return;

    if (mode === 'hard' && !hardConfirmed) {
      return;
    }

    setLoading(true);
    try {
      const res = await bridge.reset(cwd, commitHash, mode);
      if (!res.success) {
        showToast('回退失败', 'error', res.stderr);
        return;
      }
      showToast(`已执行 git reset --${mode} ${commitHash.slice(0, 8)}`, 'success');
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      showToast('回退异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
            <span>{t('commit.resetTitle')}</span>
          </DialogTitle>
          <DialogDescription className="text-xs pt-1 truncate" title={commitSubject}>
            {t('commit.targetCommit')}
            <code>{commitHash.slice(0, 8)}</code> {commitSubject ? `· ${commitSubject}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="py-3 space-y-2.5 text-xs">
          <label className="flex items-start gap-2.5 p-2 rounded-md border border-input cursor-pointer hover:bg-accent/40">
            <input
              type="radio"
              name="reset-mode"
              value="soft"
              checked={mode === 'soft'}
              onChange={() => setMode('soft')}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-foreground">{t('commit.resetSoft')}</div>
            </div>
          </label>

          <label className="flex items-start gap-2.5 p-2 rounded-md border border-input cursor-pointer hover:bg-accent/40">
            <input
              type="radio"
              name="reset-mode"
              value="mixed"
              checked={mode === 'mixed'}
              onChange={() => setMode('mixed')}
              className="mt-0.5"
            />
            <div>
              <div className="font-medium text-foreground">{t('commit.resetMixed')}</div>
            </div>
          </label>

          <label className="flex items-start gap-2.5 p-2 rounded-md border border-destructive/40 cursor-pointer bg-destructive/5 hover:bg-destructive/10">
            <input
              type="radio"
              name="reset-mode"
              value="hard"
              checked={mode === 'hard'}
              onChange={() => {
                setMode('hard');
                setHardConfirmed(false);
              }}
              className="mt-0.5 text-destructive"
            />
            <div>
              <div className="font-medium text-destructive">{t('commit.resetHard')}</div>
              <div className="text-[11px] text-destructive/80 mt-1 leading-relaxed">
                {t('commit.resetHardWarning')}
              </div>
            </div>
          </label>

          {mode === 'hard' && (
            <div className="pt-2">
              <label className="flex items-center gap-2 p-2 rounded border border-destructive/30 bg-destructive/10 text-xs text-destructive cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hardConfirmed}
                  onChange={(e) => setHardConfirmed(e.target.checked)}
                />
                <span className="font-medium">{t('commit.hardConfirmLabel')}</span>
              </label>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant={mode === 'hard' ? 'destructive' : 'default'}
            size="sm"
            disabled={loading || (mode === 'hard' && !hardConfirmed)}
            onClick={() => void handleReset()}
          >
            {loading ? t('commit.resetting') : t('commit.resetConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface GitRevertModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd?: string;
  commitHash: string;
  commitSubject?: string;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitRevertModal({
  open,
  onOpenChange,
  cwd,
  commitHash,
  commitSubject,
  onSuccess,
  showToast,
}: GitRevertModalProps) {
  const { t } = useUiTranslation('git');
  const [loading, setLoading] = useState(false);

  const handleRevert = async () => {
    const bridge = getDesktopGitBridge();
    if (!bridge || !cwd) return;

    setLoading(true);
    try {
      const res = await bridge.revert(cwd, commitHash);
      if (!res.success) {
        showToast('撤销提交失败', 'error', res.stderr);
        return;
      }
      showToast(`已成功撤销提交 ${commitHash.slice(0, 8)}`, 'success');
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      showToast('撤销提交异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4" aria-hidden="true" />
            <span>{t('commit.revertTitle')}</span>
          </DialogTitle>
          <DialogDescription className="text-xs pt-2 leading-relaxed">
            {t('commit.revertDesc', { oid: commitHash.slice(0, 8) })}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mt-4 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel')}
          </Button>
          <Button type="button" size="sm" disabled={loading} onClick={() => void handleRevert()}>
            {loading ? t('commit.reverting') : t('commit.revertSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface GitCherryPickModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd?: string;
  commitHash: string;
  commitSubject?: string;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitCherryPickModal({
  open,
  onOpenChange,
  cwd,
  commitHash,
  commitSubject,
  onSuccess,
  showToast,
}: GitCherryPickModalProps) {
  const { t } = useUiTranslation('git');
  const [loading, setLoading] = useState(false);

  const handleCherryPick = async () => {
    const bridge = getDesktopGitBridge();
    if (!bridge || !cwd) return;

    setLoading(true);
    try {
      const res = await bridge.cherryPick(cwd, commitHash);
      if (!res.success) {
        showToast('摘取提交失败', 'error', res.stderr);
        return;
      }
      showToast(`已成功摘取提交 ${commitHash.slice(0, 8)}`, 'success');
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      showToast('摘取提交异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" aria-hidden="true" />
            <span>{t('commit.cherryPickTitle')}</span>
          </DialogTitle>
          <DialogDescription className="text-xs pt-2 leading-relaxed">
            {t('commit.cherryPickDesc', { oid: commitHash.slice(0, 8) })}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mt-4 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={loading}
            onClick={() => void handleCherryPick()}
          >
            {loading ? t('commit.cherryPicking') : t('commit.cherryPickSubmit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
