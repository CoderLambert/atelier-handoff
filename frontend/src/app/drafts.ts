/**
 * @file 管理会话草稿保存与任务发送。
 * @implementation 协调本地恢复、延迟写入和幂等发送，将自动审批选项限定于本次请求。
 * @updated 2026-11-20T14:44:21+08:00
 */
import { retainedSkillSelections, type Draft } from '@shared/types';
import { parseSearchChargeLimit } from '@/features/chat/run-mode';
import type {
  SendSessionMessage,
  SessionMessageBody,
} from '@/use-query/sessions/use-send-session-message';
import { updateSessionDraft } from '@/use-query/sessions/use-update-session-draft';
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
function persistedDraft(draft: Draft): Draft {
  return {
    text: draft.text,
    contextPaths: draft.contextPaths,
    attachmentIds: draft.attachmentIds,
    extensionSelections: draft.extensionSelections,
    mode: draft.mode === 'edit' ? 'edit' : 'readonly',
  };
}
export function readDraft(id: string, server?: Draft): Draft {
  return (
    store.getState().workspace.drafts[id] ??
    persistedDraft({ ...emptyDraft(), ...server, ...localDraft(id) })
  );
}
export function updateDraft(id: string, update: DraftUpdate, server?: Draft) {
  const draft = persistedDraft(
    typeof update === 'function' ? update(readDraft(id, server)) : update,
  );
  const save = lane(id);
  const sequence = ++save.sequence;
  store.dispatch(actions.setDraft({ id, draft }));
  storage.set(key(id), JSON.stringify(draft));
  clearTimeout(save.timer);
  save.timer = setTimeout(() => {
    save.write = (save.write ?? Promise.resolve()).then(async () => {
      if (sequence !== save.sequence) return;
      try {
        await updateSessionDraft({ sessionId: id, draft });
        if (sequence === save.sequence) storage.remove(key(id));
      } catch {
        /* Keep the local draft for recovery. */
      }
    });
  }, 500);
}

export async function submitDraft(
  id: string,
  server: Draft,
  send: SendSessionMessage,
  readonlyProfile = false,
) {
  if (store.getState().workspace.submitting[id]) return;
  const save = lane(id);
  const draft = readDraft(id, server);
  const draftFingerprint = JSON.stringify(draft);
  const selection = store.getState().workspace.automaticApprovals[id];
  const automatic = readonlyProfile ? undefined : selection;
  const payload: Omit<SessionMessageBody, 'idempotencyKey'> = {
    ...draft,
    mode: readonlyProfile ? 'readonly' : automatic ? 'edit' : draft.mode,
    ...(automatic
      ? {
          approvalMode: 'automatic',
          maxSearchChargeFen: parseSearchChargeLimit(automatic.maxSearchChargeFen),
        }
      : {}),
  };
  const fingerprint = JSON.stringify(payload);
  if (save.attempt?.fingerprint !== fingerprint)
    save.attempt = { fingerprint, key: crypto.randomUUID() };
  const attempt = save.attempt;
  store.dispatch(actions.setSubmitting({ id, pending: true }));
  clearTimeout(save.timer);
  save.sequence++;
  try {
    await save.write;
    const { run } = await send({
      sessionId: id,
      body: { ...payload, idempotencyKey: attempt.key },
    });
    if (store.getState().workspace.automaticApprovals[id] === selection)
      store.dispatch(actions.setAutomaticApproval({ id }));
    // Approval options belong to the request, not the editable draft comparison.
    if (JSON.stringify(readDraft(id, server)) === draftFingerprint)
      updateDraft(id, {
        ...emptyDraft(readonlyProfile ? 'readonly' : draft.mode),
        extensionSelections: retainedSkillSelections(run.extensions),
      });
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
