/**
 * @file 将终端连接的元数据协调到查询缓存。
 * @implementation 只写 DTO 并定向失效相关项目，终端字节和连接资源留在 feature。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TerminalListResponse, TerminalRecord } from '@shared/terminal';
import { gitKeys } from '@/use-query/git/keys';
import { terminalKeys } from './keys';

export function useTerminalCache() {
  const client = useQueryClient();
  return useMemo(
    () => ({
      receive(terminal: TerminalRecord) {
        client.setQueryData<TerminalListResponse>(
          terminalKeys.list(terminal.runtimeId, terminal.sessionId),
          (current) => {
            if (!current) return current;
            return {
              ...current,
              terminals:
                terminal.state === 'closed'
                  ? current.terminals.filter((item) => item.terminalId !== terminal.terminalId)
                  : current.terminals.map((item) =>
                      item.terminalId === terminal.terminalId ? terminal : item,
                    ),
            };
          },
        );
        if (['exited', 'closed', 'cleanup-failed'].includes(terminal.state))
          void client.invalidateQueries({
            queryKey: gitKeys.overview(terminal.projectId),
            exact: true,
          });
      },
      closed(terminal: TerminalRecord) {
        void client.invalidateQueries({
          queryKey: terminalKeys.list(terminal.runtimeId, terminal.sessionId),
          exact: true,
        });
        void client.invalidateQueries({
          queryKey: gitKeys.overview(terminal.projectId),
          exact: true,
        });
      },
      refreshRuntime: () =>
        client.invalidateQueries({ queryKey: terminalKeys.capabilities, exact: true }),
    }),
    [client],
  );
}
