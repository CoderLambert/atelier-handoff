import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { RunEvent, RunStatus } from '@shared/types';
import { notifyRunFinished } from '@/notifications';
import { actions, store } from './store';

export const keys = {
  bootstrap: ['bootstrap'] as const,
  sessions: ['sessions'] as const,
  snapshot: (id?: string) => ['snapshot', id] as const,
  runs: ['runs'] as const,
  artifacts: ['artifacts'] as const,
  trace: ['trace'] as const,
};

type RefreshKey = readonly [string, ...unknown[]];
export function useRunEvents(client: QueryClient, cursor?: number) {
  const ready = cursor !== undefined;
  useEffect(() => {
    if (!ready) return;
    let latest = cursor ?? 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Map<string, RefreshKey>();
    const running = new Set<string>();
    const source = new EventSource(`/api/events?after=${latest}`);
    function scheduleRefresh() {
      if (disposed || timer || ![...pending.keys()].some((hash) => !running.has(hash))) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const [hash, key] of pending) {
          if (running.has(hash)) continue;
          pending.delete(hash);
          running.add(hash);
          const alreadyFetching = client.isFetching({ queryKey: key }) > 0;
          // An event can arrive after an in-flight request captured an older snapshot.
          void client.invalidateQueries({ queryKey: key }, { cancelRefetch: false }).finally(() => {
            running.delete(hash);
            if (disposed) return;
            if (alreadyFetching) pending.set(hash, key);
            scheduleRefresh();
          });
        }
      }, 180);
    }
    function schedule(...queryKeys: RefreshKey[]) {
      queryKeys.forEach((queryKey) => pending.set(JSON.stringify(queryKey), queryKey));
      scheduleRefresh();
    }
    function refreshVisible() {
      schedule(keys.bootstrap, keys.sessions, keys.runs, keys.artifacts, keys.trace, ['snapshot']);
    }
    source.onopen = () => {
      store.dispatch(actions.setConnected(true));
      refreshVisible();
    };
    source.onerror = () => store.dispatch(actions.setConnected(false));
    source.addEventListener('cursor-reset', (event) => {
      latest = Number((event as MessageEvent).lastEventId) || 0;
      refreshVisible();
    });
    source.onmessage = (message) => {
      const id = Number(message.lastEventId);
      if (!Number.isSafeInteger(id) || id <= latest) return;
      latest = id;
      let event: RunEvent;
      try {
        event = JSON.parse(message.data) as RunEvent;
      } catch {
        return;
      }
      if (event.sessionId) schedule(keys.snapshot(event.sessionId));
      if (event.type === 'message.delta') return;
      if (event.runId) schedule(['trace', event.runId]);
      if (
        event.type.startsWith('run.') ||
        event.type.startsWith('session.') ||
        event.type.startsWith('permission.')
      ) {
        schedule(keys.sessions, keys.runs);
      }
      if (event.type === 'artifact.created') schedule(keys.artifacts);
      if (event.type === 'run.finished') {
        notifyRunFinished(
          (event.payload as { status?: RunStatus } | undefined)?.status,
          event.sessionId,
        );
      }
      if (
        event.type === 'project.bound' ||
        event.type === 'session.created' ||
        event.type === 'session.updated' ||
        event.type === 'session.deleted' ||
        event.type === 'run.created' ||
        event.type === 'run.finished'
      ) {
        schedule(keys.bootstrap);
      }
    };
    return () => {
      disposed = true;
      clearTimeout(timer);
      source.close();
      pending.clear();
      store.dispatch(actions.setConnected(false));
    };
    // The initial cursor comes from bootstrap. EventSource owns the live cursor after opening.
  }, [client, ready]);
}
