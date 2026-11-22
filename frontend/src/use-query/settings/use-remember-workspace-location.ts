import { useMutation } from '@tanstack/react-query';
import { api } from '@/api/client';

export function useRememberWorkspaceLocation() {
  return useMutation({
    scope: { id: 'workspace-location' },
    mutationFn: (path: string) =>
      api<{ path: string }>('/api/settings/workspace-location', {
        method: 'PATCH',
        body: { path },
      }),
  }).mutate;
}
