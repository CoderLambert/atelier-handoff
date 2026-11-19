/**
 * @file 查询交付物的预览内容。
 * @implementation 按交付物 ID 请求内容与元数据，传递取消信号并保留显式重试。
 * @updated 2026-11-20T11:00:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import type { Artifact } from '@shared/types';
import { api } from '@/api/client';
import { artifactKeys } from './keys';

type ArtifactContent = {
  artifact: Artifact;
  text: string;
  previewable: boolean;
  previewKind: 'html' | 'text';
};

export function useArtifactContent(id: string) {
  return useQuery({
    queryKey: artifactKeys.content(id),
    queryFn: ({ signal }) =>
      api<ArtifactContent>(`/api/artifacts/${encodeURIComponent(id)}/content`, { signal }),
    retry: false,
  });
}
