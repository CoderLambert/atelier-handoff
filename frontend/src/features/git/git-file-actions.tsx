/**
 * @file 提供 Git 文件阅读和本机定位入口。
 * @implementation 将所选文件版本交给标签管理器，并通过桌面文件桥定位当前检出的路径。
 * @updated 2026-11-25T17:09:41+08:00
 */
import { useState } from 'react';
import { FileText, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { desktopFilesBridge } from '@/desktop-files';
import { useUiTranslation } from '@/i18n';
import type { GitOpenFile } from './git-open-file';

export function GitRevealFileButton({
  projectId,
  worktreeId,
  path,
  onRevealFailed,
}: {
  projectId: string;
  worktreeId: string;
  path?: string;
  onRevealFailed?: (message: string, type: 'error') => void;
}) {
  const { t } = useUiTranslation('git');
  const [revealing, setRevealing] = useState(false);
  const bridge = desktopFilesBridge();
  if (!bridge?.revealGitFile || !path) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={t('diff.revealFile')}
      aria-label={t('diff.revealFile')}
      disabled={revealing}
      onClick={async () => {
        setRevealing(true);
        const shown = await bridge
          .revealGitFile({ projectId, worktreeId, path })
          .catch(() => false);
        setRevealing(false);
        if (!shown) onRevealFailed?.(t('diff.revealFailed'), 'error');
      }}
    >
      <FolderOpen aria-hidden="true" />
    </Button>
  );
}

export function GitFileActions({
  projectId,
  worktreeId,
  target,
  revealPath,
  onOpenFile,
  onRevealFailed,
}: GitOpenFile & {
  projectId: string;
  onOpenFile: (file: GitOpenFile) => void;
  onRevealFailed?: (message: string, type: 'error') => void;
}) {
  const { t } = useUiTranslation('git');
  return (
    <div className="git-file-actions">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title={t('diff.fullFile')}
        aria-label={t('diff.fullFile')}
        onClick={() => onOpenFile({ target, worktreeId, revealPath })}
      >
        <FileText aria-hidden="true" />
      </Button>
      <GitRevealFileButton
        projectId={projectId}
        worktreeId={worktreeId}
        path={revealPath}
        onRevealFailed={onRevealFailed}
      />
    </div>
  );
}
