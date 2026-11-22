import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';
export function useDeleteSession() {
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: true }>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  });
}
