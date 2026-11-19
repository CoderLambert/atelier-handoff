/**
 * @file 提供项目选择与目录绑定对话框。
 * @implementation 展示已有项目，调用项目选择 hook 处理路径、选择与绑定。
 * @updated 2026-11-20T02:00+08:00
 */
import { FolderOpen } from 'lucide-react';
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

export function ProjectsDialog({
  open,
  onOpenChange,
  projects,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  onChoose: (id: string) => Promise<void>;
}) {
  const { path, setPath, busy, picking, error, close, pickDirectory, openProject } =
    useProjectSelection(onChoose, onOpenChange);
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>绑定项目目录</DialogTitle>
          <DialogDescription>选择本机目录作为会话工作区。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {projects.map((project) => (
            <Button
              key={project.id}
              variant="secondary"
              className="justify-start break-all"
              disabled={busy || !project.available}
              onClick={() => void openProject(project.id)}
            >
              {project.name} · {project.path}
              {project.available ? '' : '（不可访问）'}
            </Button>
          ))}
        </div>
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void openProject();
          }}
        >
          <label htmlFor="project-path">本机目录</label>
          <input
            id="project-path"
            className="field"
            placeholder="/home/…/project"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
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
              {picking ? '等待系统选择…' : '选择目录'}
            </Button>
            <Button type="submit" disabled={!path.trim() || busy}>
              绑定项目
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
