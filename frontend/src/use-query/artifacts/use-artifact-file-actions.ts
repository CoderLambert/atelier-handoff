/**
 * @file 管理交付物的原生另存与定位。
 * @implementation 经 preload 按 ID 执行文件操作，共享当前宿主内已成功保存的状态并阻止重复动作。
 * @updated 2026-11-20T11:00:00+08:00
 */
import { useRef } from 'react';
import {
  skipToken,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { Artifact } from '@shared/types';
import { desktopFilesBridge } from '@/desktop-files';
import { artifactKeys } from './keys';

type FileAction = 'save' | 'reveal';

export function useArtifactFileActions(artifact: Artifact) {
  const client = useQueryClient();
  const bridge = desktopFilesBridge();
  const lock = useRef(false);
  const key = artifactKeys.fileAction(artifact.id);
  const active = useIsMutating({ mutationKey: key });
  const saved = useQuery({
    queryKey: artifactKeys.savedCopy(artifact.id),
    queryFn: skipToken,
    initialData: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const mutation = useMutation({
    mutationKey: key,
    retry: false,
    mutationFn: async (action: FileAction) => {
      if (!bridge) throw new Error('当前环境不支持原生文件操作。');
      if (action === 'save') {
        if (await bridge.saveArtifact(artifact.id, artifact.name))
          client.setQueryData(artifactKeys.savedCopy(artifact.id), true);
      } else if (!(await bridge.revealArtifact(artifact.id))) {
        client.setQueryData(artifactKeys.savedCopy(artifact.id), false);
        throw new Error('已保存的副本不可用，请重新保存。');
      }
    },
  });

  async function perform(action: FileAction) {
    if (lock.current || active || artifact.availability !== 'available') return;
    lock.current = true;
    try {
      await mutation.mutateAsync(action);
    } catch {
      // The mutation owns the error displayed beside the actions.
    } finally {
      lock.current = false;
    }
  }

  return {
    desktop: Boolean(bridge),
    saved: saved.data,
    pending: active > 0 || mutation.isPending,
    error: mutation.error instanceof Error ? mutation.error.message : null,
    save: () => perform('save'),
    reveal: () => perform('reveal'),
  };
}

export type ArtifactFileActionsState = ReturnType<typeof useArtifactFileActions>;
