/**
 * @file 获取会话、工作树及执行快照。
 * @implementation 使用统一会话键和有界请求，运行期间轮询以补齐失联的事件。
 * @updated 2026-11-24T03:36:56+08:00
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { Snapshot } from '@/api/types';
import { activeStatuses } from '@shared/types';
import { sessionKeys } from './keys';

export function sessionSnapshotOptions(sessionId?: string) {
  return queryOptions({
    queryKey: sessionKeys.snapshot(sessionId),
    enabled: Boolean(sessionId),
    queryFn: ({ signal }) =>
      api<Snapshot>('/api/sessions/' + encodeURIComponent(sessionId ?? ''), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      }),
    refetchInterval: ({ state }) =>
      state.data?.runs.some((run) => activeStatuses.includes(run.status)) ? 3000 : false,
  });
}

export function useSessionSnapshot(sessionId?: string) {
  return useQuery(sessionSnapshotOptions(sessionId));
}
