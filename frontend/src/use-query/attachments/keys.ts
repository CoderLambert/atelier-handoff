/**
 * @file 定义会话附件查询键与操作的串行作用域。
 * @implementation 预览按会话及附件隔离；上传与移除共享会话级 mutation key 和 scope，快照按原会话失效。
 * @updated 2026-11-21T00:00:00+08:00
 */
export const attachmentKeys = {
  operation: (sessionId: string) => ['chat-attachments', sessionId] as const,
  content: (sessionId: string, id: string) => ['attachment-preview', sessionId, id] as const,
  documentPreview: (sessionId: string, id: string) =>
    ['attachment-document-preview', sessionId, id] as const,
  scope: (sessionId: string) => `session-attachments:${sessionId}`,
  snapshot: (sessionId: string) => ['snapshot', sessionId] as const,
};
