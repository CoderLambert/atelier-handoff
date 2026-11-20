/**
 * @file 提供会话草稿更新操作。
 * @implementation 向会话接口提交草稿，并暴露对应的 mutation。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { useMutation } from '@tanstack/react-query';
import type { Draft } from '@shared/types';
import { api } from '@/api/client';
import { sessionKeys } from './keys';

interface UpdateSessionDraftInput {
  sessionId: string;
  draft: Draft;
}
export async function updateSessionDraft({ sessionId, draft }: UpdateSessionDraftInput) {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: { draft },
  });
}

export function useUpdateSessionDraft() {
  return useMutation({
    mutationKey: sessionKeys.updateDraft,
    mutationFn: updateSessionDraft,
    retry: false,
  });
}
