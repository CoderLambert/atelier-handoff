/**
 * @file 定义人工终端查询身份和会话入口。
 * @implementation 列表缓存按 runtime 与 session 隔离，所有操作仅传已知实体 ID。
 * @updated 2026-11-26T01:00:00+08:00
 */
export const terminalKeys = {
  capabilities: ['terminal', 'capabilities'] as const,
  list: (runtimeId: string, sessionId: string) => ['terminal', runtimeId, sessionId] as const,
};
export const terminalSessionUrl = (sessionId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/terminals`;
export const terminalUrl = (sessionId: string, terminalId: string) =>
  `${terminalSessionUrl(sessionId)}/${encodeURIComponent(terminalId)}`;
