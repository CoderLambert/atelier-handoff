/**
 * @file 提供 Git 分支创建、重命名、删除与脏工作区切换确认对话框。
 * @implementation 封装分支合法性校验、自动暂存切换、未合并分支强制删除二次确认及错误反馈。
 * @updated 2026-11-25T03:36:00+08:00
 */
import { useState } from 'react';
import { AlertTriangle, GitBranch, Trash2 } from 'lucide-react';
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
import { Input } from '@/components/ui/input';

// Git 分支名称合法性校验规则
const INVALID_BRANCH_CHARS = /[~^:?*\[\\ ]|@{|\.\.|\/\/|^[/.]|[/.]\z|\.lock$/;

export function isValidBranchName(name: string): boolean {
  if (!name || name.trim().length === 0) return false;
  const trimmed = name.trim();
  if (INVALID_BRANCH_CHARS.test(trimmed)) return false;
  if (trimmed.startsWith('-')) return false;
  return true;
}

export interface GitCreateBranchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd?: string;
  startPoint?: string;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitCreateBranchModal({
  open,
  onOpenChange,
  cwd,
  startPoint,
  onSuccess,
  showToast,
}: GitCreateBranchModalProps) {
  const { t } = useUiTranslation('git');
  const [name, setName] = useState('');
  const [switchAfter, setSwitchAfter] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const branchName = name.trim();
    if (!branchName) {
      setErrorMsg(t('branch.nameRequired'));
      return;
    }
    if (!isValidBranchName(branchName)) {
      setErrorMsg(t('branch.invalidName'));
      return;
    }

    const bridge = getDesktopGitBridge();
    if (!bridge || !cwd) return;

    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await bridge.createBranch(cwd, branchName, startPoint);
      if (!res.success) {
        showToast('创建分支失败', 'error', res.stderr);
        return;
      }

      if (switchAfter) {
        const switchRes = await bridge.checkoutBranch(cwd, branchName, false);
        if (!switchRes.success) {
          showToast('切换分支失败', 'error', switchRes.stderr);
        }
      }

      showToast(`已创建分支 ${branchName}`, 'success');
      onOpenChange(false);
      setName('');
      onSuccess();
    } catch (err) {
      showToast('创建分支异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitBranch className="w-4 h-4" aria-hidden="true" />
              <span>{t('branch.createTitle')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs pt-1">
              {startPoint
                ? t('branch.createDescCommit', { oid: startPoint.slice(0, 8) })
                : t('branch.createDescHead')}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4 space-y-3">
            <div>
              <label htmlFor="git-new-branch-name" className="block text-xs font-medium mb-1">
                {t('branch.nameLabel')}
              </label>
              <Input
                id="git-new-branch-name"
                type="text"
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setErrorMsg(null);
                }}
                placeholder={t('branch.namePlaceholder')}
                className="w-full px-2.5 py-1.5 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {errorMsg && <p className="text-xs text-destructive mt-1">{errorMsg}</p>}
            </div>

            <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
              <input
                type="checkbox"
                checked={switchAfter}
                onChange={(e) => setSwitchAfter(e.target.checked)}
                className="rounded border-input text-primary"
              />
              <span>{t('branch.switchAfterCreate')}</span>
            </label>
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
            <Button type="submit" size="sm" disabled={loading || !name.trim()}>
              {loading ? t('branch.creating') : t('branch.createSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface GitRenameBranchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd?: string;
  oldName: string;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitRenameBranchModal({
  open,
  onOpenChange,
  cwd,
  oldName,
  onSuccess,
  showToast,
}: GitRenameBranchModalProps) {
  const { t } = useUiTranslation('git');
  const [newName, setNewName] = useState(oldName);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setErrorMsg(t('branch.nameRequired'));
      return;
    }
    if (trimmed === oldName) {
      onOpenChange(false);
      return;
    }
    if (!isValidBranchName(trimmed)) {
      setErrorMsg(t('branch.invalidName'));
      return;
    }

    const bridge = getDesktopGitBridge();
    if (!bridge || !cwd) return;

    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await bridge.renameBranch(cwd, oldName, trimmed);
      if (!res.success) {
        showToast('重命名分支失败', 'error', res.stderr);
        return;
      }
      showToast(`已将分支重命名为 ${trimmed}`, 'success');
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      showToast('重命名分支异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('branch.renameTitle')}</DialogTitle>
            <DialogDescription className="text-xs pt-1">
              {t('branch.renameDesc', { name: oldName })}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            <label htmlFor="git-rename-branch-input" className="block text-xs font-medium mb-1">
              {t('branch.renameNewName')}
            </label>
            <Input
              id="git-rename-branch-input"
              type="text"
              autoFocus
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setErrorMsg(null);
              }}
              className="w-full px-2.5 py-1.5 text-xs rounded-md bg-background border border-input focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {errorMsg && <p className="text-xs text-destructive mt-1">{errorMsg}</p>}
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
              type="submit"
              size="sm"
              disabled={loading || !newName.trim() || newName === oldName}
            >
              {loading ? t('branch.saving') : t('branch.renameSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export interface GitDeleteBranchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd?: string;
  branchName: string;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitDeleteBranchModal({
  open,
  onOpenChange,
  cwd,
  branchName,
  onSuccess,
  showToast,
}: GitDeleteBranchModalProps) {
  const { t } = useUiTranslation('git');
  const [loading, setLoading] = useState(false);
  const [isUnmerged, setIsUnmerged] = useState(false);

  const handleDelete = async (force: boolean) => {
    const bridge = getDesktopGitBridge();
    if (!bridge || !cwd) return;

    setLoading(true);
    try {
      const res = await bridge.deleteBranch(cwd, branchName, force);
      if (!res.success) {
        const errText = (res.stderr || '').toLowerCase();
        if (!force && (errText.includes('not fully merged') || errText.includes('force'))) {
          setIsUnmerged(true);
          return;
        }
        showToast('删除分支失败', 'error', res.stderr);
        return;
      }
      showToast(`已删除分支 ${branchName}`, 'success');
      onOpenChange(false);
      setIsUnmerged(false);
      onSuccess();
    } catch (err) {
      showToast('删除分支异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!loading) {
          setIsUnmerged(false);
          onOpenChange(o);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-destructive" aria-hidden="true" />
            <span>{t('branch.deleteConfirmTitle')}</span>
          </DialogTitle>
          <DialogDescription className="text-xs pt-2 leading-relaxed">
            {isUnmerged
              ? t('branch.forceDeleteConfirmDesc', { name: branchName })
              : t('branch.deleteConfirmDesc', { name: branchName })}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="mt-4 gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => {
              setIsUnmerged(false);
              onOpenChange(false);
            }}
          >
            {t('actions.cancel')}
          </Button>
          {isUnmerged ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={loading}
              onClick={() => void handleDelete(true)}
            >
              {loading ? t('branch.deleting') : t('branch.forceDeleteButton')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={loading}
              onClick={() => void handleDelete(false)}
            >
              {loading ? t('branch.deleting') : t('branch.deleteSubmit')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface GitCheckoutDirtyModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd?: string;
  targetBranch: string;
  onSuccess: () => void;
  showToast: (msg: string, type?: 'success' | 'error', stderr?: string) => void;
}

export function GitCheckoutDirtyModal({
  open,
  onOpenChange,
  cwd,
  targetBranch,
  onSuccess,
  showToast,
}: GitCheckoutDirtyModalProps) {
  const { t } = useUiTranslation('git');
  const [loading, setLoading] = useState(false);

  const handleCheckout = async (autoStash: boolean) => {
    const bridge = getDesktopGitBridge();
    if (!bridge || !cwd) return;

    setLoading(true);
    try {
      const res = await bridge.checkoutBranch(cwd, targetBranch, autoStash);
      if (!res.success) {
        showToast('切换分支失败', 'error', res.stderr);
        return;
      }
      showToast(`已切换到分支 ${targetBranch}`, 'success');
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      showToast('切换分支异常', 'error', err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 git-dialog-warning-icon" aria-hidden="true" />
            <span>{t('branch.checkoutTitle')}</span>
          </DialogTitle>
          <DialogDescription className="text-xs pt-2 leading-relaxed">
            {t('branch.checkoutConfirmDirty')}
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
            onClick={() => void handleCheckout(true)}
          >
            {loading ? t('branch.switching') : t('branch.autoStashSwitch')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
