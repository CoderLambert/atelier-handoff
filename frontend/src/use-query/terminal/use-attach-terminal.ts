/**
 * @file 为终端连接签发一次性附着票据。
 * @implementation 每次连接通过现有 CSRF 传输重新请求票据，票据只留在调用栈中。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useMutation } from '@tanstack/react-query';
import { terminalTicketResponseSchema, type TerminalRecord } from '@shared/terminal';
import { api, ApiError } from '@/api/client';
import { terminalUrl } from './keys';

export async function requestTerminalAttachment(
  terminal: Pick<TerminalRecord, 'runtimeId' | 'sessionId' | 'terminalId'>,
  signal?: AbortSignal,
) {
  const ticket = terminalTicketResponseSchema.parse(
    await api(`${terminalUrl(terminal.sessionId, terminal.terminalId)}/attach-ticket`, {
      method: 'POST',
      body: { runtimeId: terminal.runtimeId },
      signal,
    }),
  );
  if (ticket.runtimeId !== terminal.runtimeId)
    throw new ApiError('Terminal runtime changed', 409, 'TERMINAL_RUNTIME_CHANGED');
  return ticket;
}
export function useAttachTerminal() {
  return useMutation({
    mutationFn: (terminal: TerminalRecord) => requestTerminalAttachment(terminal),
    retry: false,
  });
}
