/**
 * @file 查询会话在当前运行时中的终端。
 * @implementation 拒绝跨运行时代次的迟到列表，轮询仅更新元数据。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { terminalListResponseSchema } from '@shared/terminal';
import { api, ApiError } from '@/api/client';
import { terminalKeys, terminalSessionUrl } from './keys';

export function useListTerminals(runtimeId: string | undefined, sessionId: string, enabled = true) {
  return useQuery({
    queryKey: terminalKeys.list(runtimeId ?? '', sessionId),
    enabled: Boolean(runtimeId) && enabled,
    queryFn: async ({ signal }) => {
      const result = terminalListResponseSchema.parse(
        await api(terminalSessionUrl(sessionId), { signal }),
      );
      if (
        result.runtimeId !== runtimeId ||
        result.terminals.some(
          (item) => item.sessionId !== sessionId || item.runtimeId !== runtimeId,
        )
      )
        throw new ApiError('Terminal runtime changed', 409, 'TERMINAL_RUNTIME_CHANGED');
      return result;
    },
    retry: false,
    staleTime: 0,
    refetchInterval: 3_000,
  });
}
