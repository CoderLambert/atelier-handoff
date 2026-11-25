/**
 * @file 读取当前运行时的终端能力。
 * @implementation 校验能力响应并定期发现运行时代次变化，不隐式创建终端。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useQuery } from '@tanstack/react-query';
import { terminalCapabilitiesSchema } from '@shared/terminal';
import { api } from '@/api/client';
import { terminalKeys } from './keys';

export function useTerminalCapabilities() {
  return useQuery({
    queryKey: terminalKeys.capabilities,
    queryFn: async ({ signal }) =>
      terminalCapabilitiesSchema.parse(await api('/api/terminals/capabilities', { signal })),
    staleTime: 10_000,
    refetchInterval: 15_000,
    retry: false,
  });
}
