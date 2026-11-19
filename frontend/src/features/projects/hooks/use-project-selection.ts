/**
 * @file 管理项目选择和目录绑定流程。
 * @implementation 组合绑定与目录选择请求，处理取消、忙碌和错误状态。
 * @updated 2026-11-20T02:00+08:00
 */
import { useEffect, useRef, useState } from 'react';
import { useBindProject } from '@/use-query/projects/use-bind-project';
import { usePickProjectDirectory } from '@/use-query/projects/use-pick-project-directory';

export function useProjectSelection(
  onChoose: (id: string) => Promise<void>,
  onOpenChange: (open: boolean) => void,
) {
  const [path, setPath] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<AbortController | null>(null);
  const bind = useBindProject();
  const pick = usePickProjectDirectory();
  const busy = choosing || bind.isPending || pick.isPending;
  useEffect(() => () => picker.current?.abort(), []);

  function close(open: boolean) {
    if (!open) picker.current?.abort();
    onOpenChange(open);
  }
  async function pickDirectory() {
    if (busy || picker.current) return;
    setError('');
    const controller = new AbortController();
    picker.current = controller;
    try {
      const result = await pick.mutateAsync(controller.signal);
      if (!controller.signal.aborted && result.path) setPath(result.path);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '无法打开目录选择器。');
    } finally {
      picker.current = null;
    }
  }
  async function openProject(id?: string) {
    if (busy || (!id && !path.trim())) return;
    setChoosing(true);
    setError('');
    try {
      const projectId = id ?? (await bind.mutateAsync(path.trim())).project.id;
      await onChoose(projectId);
      close(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法打开项目。');
    } finally {
      setChoosing(false);
    }
  }
  return { path, setPath, busy, picking: pick.isPending, error, close, pickDirectory, openProject };
}
