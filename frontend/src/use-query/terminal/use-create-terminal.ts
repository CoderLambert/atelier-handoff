/**
 * @file 创建一个显式请求的会话终端。
 * @implementation 保留请求 terminalId 用于安全重试，核对响应身份并更新对应列表。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  terminalCreateResponseSchema,
  type TerminalCreateRequest,
  type TerminalListResponse,
} from '@shared/terminal';
import { api, ApiError } from '@/api/client';
import { gitKeys } from '@/use-query/git/keys';
import { terminalKeys, terminalSessionUrl } from './keys';

export function useCreateTerminal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      sessionId,
      request,
    }: {
      sessionId: string;
      request: TerminalCreateRequest;
    }) => {
      const result = terminalCreateResponseSchema.parse(
        await api(terminalSessionUrl(sessionId), { method: 'POST', body: request }),
      );
      if (
        result.terminal.runtimeId !== request.runtimeId ||
        result.terminal.sessionId !== sessionId ||
        result.terminal.terminalId !== request.terminalId
      )
        throw new ApiError('Terminal response changed', 409, 'TERMINAL_RUNTIME_CHANGED');
      return result.terminal;
    },
    retry: false,
    onMutate: async ({ sessionId, request }) =>
      client.cancelQueries({
        queryKey: terminalKeys.list(request.runtimeId, sessionId),
        exact: true,
      }),
    onSuccess: (terminal) => {
      client.setQueryData<TerminalListResponse>(
        terminalKeys.list(terminal.runtimeId, terminal.sessionId),
        (current) => ({
          runtimeId: terminal.runtimeId,
          terminals: [
            ...(current?.terminals ?? []).filter((item) => item.terminalId !== terminal.terminalId),
            terminal,
          ],
        }),
      );
      void client.invalidateQueries({
        queryKey: gitKeys.overview(terminal.projectId),
        exact: true,
      });
    },
  });
}
