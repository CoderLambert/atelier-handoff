export const sessionKeys = {
  snapshot: (id: string) => ['snapshot', id] as const,
  sendMessage: ['sessions', 'send-message'] as const,
  updateDraft: ['sessions', 'update-draft'] as const,
};
