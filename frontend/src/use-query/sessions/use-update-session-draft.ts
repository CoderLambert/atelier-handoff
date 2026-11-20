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
