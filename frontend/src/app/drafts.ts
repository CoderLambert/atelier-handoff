/**
 * @file 管理会话草稿、引用、运行偏好与任务发送。
 * @implementation 按项目复用新会话草稿编号并在本地保存编辑内容。已有会话的草稿串行同步，提交时组合正文、引用与幂等键。
 * @updated 2026-11-28T15:51:00+08:00
 */
import {
  composerTextLimit,
  formatMessageText,
  messageQuotesSchema,
  type FileQuoteSource,
} from '@shared/message-quotes';
import {
  reasoningEfforts,
  retainedSkillSelections,
  type Draft,
  type ExtensionSelection,
} from '@shared/types';
import { appendDraftQuote } from '@/features/chat/composer-policy';
import { draftSelectionLimit } from '@/features/extensions/inheritance-model';
import { parseSearchChargeLimit } from '@/features/chat/run-mode';
import { getTranslator } from '@/i18n';
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
const newSessionPrefix = 'new:';
const isNewSessionDraft = (id: string) => id.startsWith(newSessionPrefix);
export const emptyDraft = (mode: Draft['mode'] = 'readonly'): Draft => ({
  text: '',
  contextPaths: [],
  attachmentIds: [],
  extensionSelections: [],
  mode,
});
export const defaultNewSessionDraft = (nativeExecution: boolean): Draft =>
  nativeExecution ? { ...emptyDraft('edit'), executionPreference: 'native-v1' } : emptyDraft();

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
const projectDraftKey = (projectId: string) => `atelier-new-session:${projectId}`;
const windowDraftIds = new Map<string, string>();

export function newSessionDraftId(projectId: string) {
  const saved = windowDraftIds.get(projectId) ?? storage.get(projectDraftKey(projectId));
  const id = saved ?? crypto.randomUUID();
  windowDraftIds.set(projectId, id);
  storage.set(projectDraftKey(projectId), id);
  return id;
}

export async function finishNewSessionDraft(projectId: string, id: string) {
  if (windowDraftIds.get(projectId) === id) {
    windowDraftIds.delete(projectId);
    storage.remove(projectDraftKey(projectId));
  }
  await deleteDraft(`new:${id}`, async () => {});
}

export function seedSkillDraft(
  projectId: string,
  selection: ExtensionSelection,
  editable: boolean,
) {
  const id = `new:${newSessionDraftId(projectId)}`;
  if (store.getState().workspace.submitting[id]) return;
  updateDraft(id, (draft) => {
    const others = (draft.extensionSelections ?? []).filter((item) => item.id !== selection.id);
    if (others.length >= draftSelectionLimit)
      throw new Error(
        getTranslator('extensions')('inheritance.selectionLimit', { count: draftSelectionLimit }),
      );
    return {
      ...draft,
      extensionSelections: [...others, selection],
      mode: editable ? 'edit' : 'readonly',
      executionPreference: 'project-v1',
      approvalMode: undefined,
    };
  });
}

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
  const quotes = messageQuotesSchema.safeParse(draft.messageQuotes).data;
  return {
    text: draft.text,
    ...(quotes?.length ? { messageQuotes: quotes } : {}),
    contextPaths: draft.contextPaths,
    attachmentIds: draft.attachmentIds,
    extensionSelections: draft.extensionSelections,
    mode: draft.mode === 'edit' ? 'edit' : 'readonly',
    ...(typeof draft.model === 'string' && draft.model ? { model: draft.model } : {}),
    ...(draft.effort && reasoningEfforts.includes(draft.effort) ? { effort: draft.effort } : {}),
    ...(draft.executionPreference === 'project-v1' ||
    (draft.executionPreference === 'native-v1' && draft.mode === 'edit' && !draft.approvalMode)
      ? { executionPreference: draft.executionPreference }
      : {}),
    ...(draft.mode === 'edit' && draft.approvalMode === 'automatic'
      ? { approvalMode: draft.approvalMode }
      : {}),
  };
}
export function readDraft(id: string, server?: Draft): Draft {
  const current = store.getState().workspace.drafts[id];
  if (current) return current;
  const local = localDraft(id);
  return persistedDraft({
    ...emptyDraft(),
    ...server,
    ...local,
    // A complete local draft can explicitly clear either saved preference.
    ...(local.mode
      ? {
          approvalMode: local.approvalMode,
          executionPreference: local.executionPreference,
          model: local.model,
          effort: local.effort,
          messageQuotes: local.messageQuotes,
        }
      : {}),
  });
}
export function updateDraft(id: string, update: DraftUpdate, server?: Draft, immediate = false) {
  const draft = persistedDraft(
    typeof update === 'function' ? update(readDraft(id, server)) : update,
  );
  const save = lane(id);
  const sequence = ++save.sequence;
  store.dispatch(actions.setDraft({ id, draft }));
  if (isNewSessionDraft(id)) {
    storage.set(key(id), JSON.stringify({ ...draft, attachmentIds: [] }));
    return;
  }
  storage.set(key(id), JSON.stringify(draft));
  clearTimeout(save.timer);
  const enqueue = () => {
    save.write = (save.write ?? Promise.resolve()).then(async () => {
      if (sequence !== save.sequence) return;
      try {
        await updateSessionDraft({ sessionId: id, draft });
        if (sequence === save.sequence) storage.remove(key(id));
      } catch {
        /* Keep the local draft for recovery. */
      }
    });
  };
  if (immediate) enqueue();
  else save.timer = setTimeout(enqueue, 500);
}

export function appendFileQuote(id: string, server: Draft, file: FileQuoteSource, text: string) {
  if (store.getState().workspace.submitting[id]) return 'unavailable';
  const draft = readDraft(id, server);
  const result = appendDraftQuote(draft, { id: `quote:${crypto.randomUUID()}`, text, file });
  if (result.status !== 'added') return result.status;
  updateDraft(id, { ...draft, messageQuotes: result.messageQuotes }, server, true);
  return 'added';
}

export async function submitDraft(
  id: string,
  server: Draft,
  send: SendSessionMessage,
  readonlyProfile = false,
  defaultModel?: string,
  nativeExecution = false,
) {
  if (store.getState().workspace.submitting[id]) return;
  const save = lane(id);
  const draft = readDraft(id, server);
  const draftFingerprint = JSON.stringify(draft);
  const searchChargeLimit = store.getState().workspace.searchChargeLimits[id];
  const approvalMode = readonlyProfile ? undefined : draft.approvalMode;
  const executionPreference =
    draft.executionPreference === 'native-v1' && (!nativeExecution || readonlyProfile)
      ? 'project-v1'
      : draft.executionPreference;
  const { messageQuotes, ...input } = draft;
  const text = formatMessageText(input.text, messageQuotes);
  if (text.length > composerTextLimit)
    throw new Error(getTranslator('navigation')('drafts.inputTooLong'));
  const payload: Omit<SessionMessageBody, 'idempotencyKey'> = {
    ...input,
    text,
    mode: readonlyProfile ? 'readonly' : draft.mode,
    model: draft.model ?? defaultModel,
    approvalMode,
    executionPreference,
    ...(approvalMode
      ? { maxSearchChargeFen: parseSearchChargeLimit(searchChargeLimit ?? '0') }
      : {}),
  };
  const fingerprint = JSON.stringify(payload);
  if (save.attempt?.fingerprint !== fingerprint)
    save.attempt = { fingerprint, key: crypto.randomUUID() };
  const attempt = save.attempt;
  store.dispatch(actions.setSubmitting({ id, pending: true }));
  clearTimeout(save.timer);
  try {
    await save.write;
    const result = await send({
      sessionId: id,
      body: { ...payload, idempotencyKey: attempt.key },
    });
    if (store.getState().workspace.searchChargeLimits[id] === searchChargeLimit)
      store.dispatch(actions.setSearchChargeLimit({ id }));
    if (JSON.stringify(readDraft(id, server)) === draftFingerprint) {
      const receipt = result.run ?? result.queuedMessage;
      updateDraft(isNewSessionDraft(id) ? id.slice(newSessionPrefix.length) : id, {
        ...emptyDraft(readonlyProfile ? 'readonly' : draft.mode),
        approvalMode,
        executionPreference,
        model: draft.model,
        effort: draft.effort,
        extensionSelections: retainedSkillSelections(receipt.extensions),
      });
    }
    save.attempt = undefined;
    return result;
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
