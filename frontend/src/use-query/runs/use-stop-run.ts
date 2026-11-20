import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Run } from '@shared/types';
import { api } from '@/api/client';
import { sessionKeys } from '@/use-query/sessions/keys';
import { runKeys } from './keys';

export function useStopRun(run: Pick<Run, 'id' | 'sessionId'>) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: runKeys.stop(run.id),
    mutationFn: () =>
      api<{ run: Run }>(`/api/runs/${encodeURIComponent(run.id)}/stop`, {
        method: 'POST',
        body: {},
      }),
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: sessionKeys.snapshot(run.sessionId) });
      void client.invalidateQueries({ queryKey: ['bootstrap'] });
      void client.invalidateQueries({ queryKey: ['runs'] });
      void client.invalidateQueries({ queryKey: runKeys.trace(run.id) });
    },
  });
}
