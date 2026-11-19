/**
 * @file 定义会话附件操作的键与串行作用域。
 * @implementation 上传与移除共享会话级 mutation key 和 scope，快照按原会话失效。
 * @updated 2026-11-20T11:00:00+08:00
 */
export const attachmentKeys = {
  operation: (sessionId: string) => ['chat-attachments', sessionId] as const,
  scope: (sessionId: string) => `session-attachments:${sessionId}`,
  snapshot: (sessionId: string) => ['snapshot', sessionId] as const,
};
