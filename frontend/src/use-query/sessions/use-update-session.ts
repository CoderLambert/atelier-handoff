import { useMutation } from '@tanstack/react-query';
import type { Session } from '@shared/types';
import { api } from '@/api/client';
export function useUpdateSession() {
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: Pick<Session, 'id'> & Partial<Pick<Session, 'title' | 'status'>>) =>
      api<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body,
      }),
  });
}
