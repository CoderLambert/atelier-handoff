/**
 * @file 结束指定终端并更新元数据。
 * @implementation 关闭请求携带 runtime 身份，保留失败状态并精准刷新会话列表及工作树占用。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { terminalCloseResponseSchema, type TerminalRecord } from '@shared/terminal';
import { api, ApiError } from '@/api/client';
import { gitKeys } from '@/use-query/git/keys';
import { terminalKeys, terminalUrl } from './keys';

export function useCloseTerminal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (terminal: TerminalRecord) => {
      const result = terminalCloseResponseSchema.parse(
        await api(terminalUrl(terminal.sessionId, terminal.terminalId), {
          method: 'DELETE',
          body: { runtimeId: terminal.runtimeId },
        }),
      );
      if (result.runtimeId !== terminal.runtimeId || result.terminalId !== terminal.terminalId)
        throw new ApiError('Terminal response changed', 409, 'TERMINAL_RUNTIME_CHANGED');
      return result;
    },
    retry: false,
    onSettled: (_data, _error, terminal) =>
      Promise.all([
        client.invalidateQueries({
          queryKey: terminalKeys.list(terminal.runtimeId, terminal.sessionId),
          exact: true,
        }),
        client.invalidateQueries({ queryKey: gitKeys.overview(terminal.projectId), exact: true }),
      ]),
  });
}
