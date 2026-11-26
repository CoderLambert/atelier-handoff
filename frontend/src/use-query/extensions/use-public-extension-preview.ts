/**
 * @file 查询项目的公开扩展预览。
 * @implementation 缓存来源与固定提交组合，并将查询取消传到 HTTP。
 * @updated 2026-11-26T12:00:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { PublicEntry, PublicPreviewInput } from '@shared/public-extensions';
import { endpoint, extensionKeys } from './keys';

export function usePublicExtensionPreview(projectId: string, input: PublicPreviewInput) {
  return useQuery({
    queryKey: extensionKeys.publicPreview(projectId, input),
    queryFn: async ({ signal }) => {
      const result = await api<{ items: PublicEntry[] }>(endpoint(projectId, 'public-preview'), {
        method: 'POST',
        body: input,
        signal,
      });
      if (!Array.isArray(result?.items)) throw new Error('公开来源响应缺少 items。');
      return result.items;
    },
    enabled: Boolean(projectId && input.source),
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
}
