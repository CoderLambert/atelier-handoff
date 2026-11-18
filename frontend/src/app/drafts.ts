import type { Draft } from '@shared/types';
import { api } from '@/api/client';
import { actions, store } from './store';

type DraftUpdate = Draft | ((previous: Draft) => Draft);
interface SaveLane {
  timer?: ReturnType<typeof setTimeout>;
  sequence: number;
  write?: Promise<void>;
  attempt?: { fingerprint: string; key: string };
}
const saves = new Map<string, SaveLane>();
const lastSessionKey = 'atelier-last-session';
const key = (id: string) => `atelier-draft:${id}`;
export const emptyDraft = (mode: Draft['mode'] = 'readonly'): Draft => ({
  text: '',
  contextPaths: [],
  attachmentIds: [],
  extensionSelections: [],
  mode,
});

export const storage = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Keep in-memory draft. */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Storage is optional. */
    }
  },
};
export function lastSession() {
  return storage.get(lastSessionKey);
}
export function rememberSession(id?: string) {
  if (id) storage.set(lastSessionKey, id);
  else storage.remove(lastSessionKey);
}

function lane(id: string) {
  const existing = saves.get(id);
  if (existing) return existing;
  const created: SaveLane = { sequence: 0 };
  saves.set(id, created);
  return created;
}
function localDraft(id: string): Partial<Draft> {
  try {
    return JSON.parse(storage.get(key(id)) ?? '{}') as Partial<Draft>;
  } catch {
    return {};
  }
}
export function readDraft(id: string, server?: Draft): Draft {
  return store.getState().workspace.drafts[id] ?? { ...emptyDraft(), ...server, ...localDraft(id) };
}
export function updateDraft(id: string, update: DraftUpdate, server?: Draft) {
  const draft = typeof update === 'function' ? update(readDraft(id, server)) : update;
  const save = lane(id);
  const sequence = ++save.sequence;
  store.dispatch(actions.setDraft({ id, draft }));
  storage.set(key(id), JSON.stringify(draft));
  clearTimeout(save.timer);
  save.timer = setTimeout(() => {
    save.write = (save.write ?? Promise.resolve()).then(async () => {
      if (sequence !== save.sequence) return;
      try {
        await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { draft } });
        if (sequence === save.sequence) storage.remove(key(id));
      } catch {
        /* Keep the local draft for recovery. */
      }
    });
  }, 500);
}

export async function submitDraft(id: string, server: Draft) {
  if (store.getState().workspace.submitting[id]) return;
  const save = lane(id);
  const draft = readDraft(id, server);
  const fingerprint = JSON.stringify(draft);
  if (save.attempt?.fingerprint !== fingerprint)
    save.attempt = { fingerprint, key: crypto.randomUUID() };
  const attempt = save.attempt;
  store.dispatch(actions.setSubmitting({ id, pending: true }));
  clearTimeout(save.timer);
  save.sequence++;
  await save.write;
  try {
    await api(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: { ...draft, idempotencyKey: attempt.key },
    });
    if (JSON.stringify(readDraft(id, server)) === fingerprint)
      updateDraft(id, emptyDraft(draft.mode));
    save.attempt = undefined;
  } catch (error) {
    updateDraft(id, readDraft(id, server));
    throw error;
  } finally {
    store.dispatch(actions.setSubmitting({ id, pending: false }));
  }
}

export async function deleteDraft(id: string, remove: () => Promise<unknown>) {
  const save = lane(id);
  save.sequence++;
  clearTimeout(save.timer);
  await save.write;
  try {
    await remove();
  } catch (error) {
    const current = store.getState().workspace.drafts[id];
    if (current) updateDraft(id, current);
    throw error;
  }
  clearTimeout(save.timer);
  save.sequence++;
  saves.delete(id);
  storage.remove(key(id));
  store.dispatch(actions.dropDraft(id));
}
