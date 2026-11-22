import { useMutation } from '@tanstack/react-query';
import type { Session } from '@shared/types';
import { api } from '@/api/client';
export function useCreateSession() {
  return useMutation({
    mutationFn: (projectId: string) =>
      api<{ session: Session }>('/api/sessions', { method: 'POST', body: { projectId } }),
  });
}
