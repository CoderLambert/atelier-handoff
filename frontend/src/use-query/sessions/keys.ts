/**
 * @file 定义会话快照与写操作的查询键。
 * @implementation 区分快照、发送和草稿操作，以及按会话隔离的消息队列撤回与继续操作键。
 * @updated 2026-11-20T23:09:03+08:00
 */
export const sessionKeys = {
  snapshot: (id: string) => ['snapshot', id] as const,
  sendMessage: ['sessions', 'send-message'] as const,
  updateDraft: ['sessions', 'update-draft'] as const,
  messageQueue: (id: string) => ['sessions', id, 'message-queue'] as const,
  withdrawMessage: (id: string) => ['sessions', id, 'message-queue', 'withdraw'] as const,
  resumeQueue: (id: string) => ['sessions', id, 'message-queue', 'resume'] as const,
};
