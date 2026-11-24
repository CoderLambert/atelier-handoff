/**
 * @file 提供项目选择与目录绑定对话框。
 * @implementation 展示已有项目，调用项目选择 hook 处理路径、选择与绑定。
 * @updated 2026-11-20T02:00+08:00
 */
import { FolderOpen, GitBranch } from 'lucide-react';
import { useProjectSelection } from '@/features/projects/hooks/use-project-selection';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Project } from '@shared/types';
import { translateError, useUiTranslation } from '@/i18n';

export function ProjectsDialog({
  open,
  onOpenChange,
  projects,
  onChoose,
  onGit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onChoose: (id: string) => Promise<void>;
  onGit: (project: Project) => void;
}) {
  const { t } = useUiTranslation('navigation');
  const { t: git } = useUiTranslation('git');
  const { path, setPath, busy, picking, error, close, pickDirectory, openProject } =
    useProjectSelection(onChoose, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('projects.title')}</DialogTitle>
          <DialogDescription>{t('projects.description')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {projects.map((project) => (
            <div key={project.id} className="flex min-w-0 items-center gap-2">
              <Button
                variant="secondary"
                className="min-w-0 flex-1 justify-start"
                disabled={busy || !project.available}
                title={project.path}
                onClick={() => void openProject(project.id)}
              >
                <span className="truncate">
                  {project.name} · {project.path}
                  {project.available ? '' : t('projects.unavailable')}
                </span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !project.available}
                onClick={() => onGit(project)}
              >
                <GitBranch data-icon="inline-start" aria-hidden="true" />
                {git('title')}
              </Button>
            </div>
          ))}
        </div>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void openProject();
          }}
        >
          <label htmlFor="project-path">{t('projects.localDirectory')}</label>
          <input
            id="project-path"
            className="field"
            placeholder={t('projects.pathPlaceholder')}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {translateError(error, t('projects.openFailed'))}
            </p>
          ) : null}
          <div className="dialog-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void pickDirectory()}
            >
              <FolderOpen size={16} />
              {picking ? t('projects.waitingForPicker') : t('projects.chooseDirectory')}
            </Button>
            <Button type="submit" disabled={!path.trim() || busy}>
              {t('projects.bind')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
