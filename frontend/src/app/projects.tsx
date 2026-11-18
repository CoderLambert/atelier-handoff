import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import { api } from '@/api/client';
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
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function pick() {
    const request = new AbortController();
    controller.current = request;
    setPicking(true);
    setError('');
    try {
      const result = await api<{ path: string | null }>('/api/projects/pick-directory', {
        method: 'POST',
        body: {},
        signal: request.signal,
      });
      if (result.path) setPath(result.path);
    } catch (error) {
      if (!request.signal.aborted) setError((error as Error).message);
    } finally {
      setPicking(false);
      controller.current = null;
    }
  }
  async function choose(id: string) {
    setBusy(true);
    setError('');
    try {
      await onChoose(id);
      onOpenChange(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function bind(event: FormEvent) {
    event.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: { path: path.trim() },
      });
      await choose(result.project.id);
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) controller.current?.abort();
        onOpenChange(next);
      }}
    >
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
              onClick={() => void choose(project.id)}
            >
              {project.name} · {project.path}
              {project.available ? '' : '（不可访问）'}
            </Button>
          ))}
        </div>
        <form className="mt-4 grid gap-3" onSubmit={(event) => void bind(event)}>
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
            <Button variant="secondary" disabled={busy || picking} onClick={() => void pick()}>
              <FolderOpen size={16} />
              {picking ? '等待系统选择…' : '选择目录'}
            </Button>
            <Button type="submit" disabled={!path.trim() || busy || picking}>
              绑定项目
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
