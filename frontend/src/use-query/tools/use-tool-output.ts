/**
 * @file 按工具调用 ID 分页读取完整输出。
 * @implementation 校验展示视图的字符分页回执，以工具 ID 和偏移隔离查询，并提供完整输出下载地址。
 * @updated 2026-11-22T18:43:19+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/api/client';

const page = z.object({
  text: z.string(),
  offset: z.int().nonnegative(),
  total: z.int().nonnegative(),
  nextOffset: z.int().nonnegative().nullable(),
});
const outputPath = (id: string) => `/api/tools/${encodeURIComponent(id)}/output`;
export const toolOutputDownloadUrl = (id: string) => `${outputPath(id)}?view=display&download=1`;
export const outputPageSize = 16_000;
export function useToolOutput(id: string, offset: number) {
  return useQuery({
    queryKey: ['tools', id, 'output', 'display', offset],
    queryFn: async ({ signal }) =>
      page.parse(
        await api<unknown>(
          `${outputPath(id)}?view=display&offset=${offset}&limit=${outputPageSize}`,
          {
            signal,
          },
        ),
      ),
    retry: false,
    staleTime: Infinity,
  });
}
