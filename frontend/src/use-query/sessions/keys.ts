/**
 * @file 定义会话快照与写操作的查询键。
 * @implementation 区分快照、发送消息和更新草稿所用的键。
 * @updated 2026-11-20T14:44:21+08:00
 */
export const sessionKeys = {
  snapshot: (id: string) => ['snapshot', id] as const,
  sendMessage: ['sessions', 'send-message'] as const,
  updateDraft: ['sessions', 'update-draft'] as const,
};
