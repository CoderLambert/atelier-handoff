export interface RunListFilters {
  projectId: string;
  sessionId: string;
  status: string;
  limit: number;
  offset: number;
}

export const runKeys = {
  list: (filters: RunListFilters | undefined) => ['runs', filters] as const,
  trace: (id: string) => ['trace', id] as const,
  stop: (id: string) => ['runs', id, 'stop'] as const,
  retry: (id: string) => ['runs', id, 'retry'] as const,
};
