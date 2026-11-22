import { useQueries } from '@tanstack/react-query';
import { activeStatuses } from '@shared/types';
import { runsQuery } from './use-runs';

/** Reuse the run-list operation and its SSE-invalidated keys for sidebar activity. */
export function useActiveRuns() {
  return useQueries({
    queries: activeStatuses.map((status) =>
      runsQuery({
        projectId: '',
        sessionId: '',
        status,
        limit: 500,
        offset: 0,
      }),
    ),
  });
}
