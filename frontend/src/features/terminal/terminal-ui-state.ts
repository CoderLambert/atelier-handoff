/**
 * @file 管理终端面板中按会话隔离的选择。
 * @implementation 单一 reducer 保存选择，sessionStorage 仅作经过运行时及服务端列表核对的恢复检查点。
 * @updated 2026-11-26T01:00:00+08:00
 */
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

const selectionSchema = z.strictObject({
  runtimeId: z.uuid(),
  sessions: z.record(z.uuid(), z.uuid()),
});
export type TerminalSelectionState = z.infer<typeof selectionSchema>;
type SelectionAction =
  | { type: 'runtime'; runtimeId: string }
  | { type: 'select'; runtimeId: string; sessionId: string; terminalId?: string };
export function terminalSelectionReducer(
  state: TerminalSelectionState,
  action: SelectionAction,
): TerminalSelectionState {
  if (action.type === 'runtime')
    return state.runtimeId === action.runtimeId
      ? state
      : { runtimeId: action.runtimeId, sessions: {} };
  if (state.runtimeId !== action.runtimeId) return state;
  if (state.sessions[action.sessionId] === action.terminalId) return state;
  const sessions = { ...state.sessions };
  if (action.terminalId) sessions[action.sessionId] = action.terminalId;
  else delete sessions[action.sessionId];
  return { ...state, sessions };
}
const storageKey = 'atelier.terminal-selection.v1';
let state: TerminalSelectionState = { runtimeId: '', sessions: {} };
let loaded = false;
const listeners = new Set<() => void>();
function publish(action: SelectionAction): void {
  const next = terminalSelectionReducer(state, action);
  if (next === state) return;
  state = next;
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    /* Selection remains usable without storage. */
  }
  for (const listener of listeners) listener();
}
export function observeTerminalSelectionRuntime(runtimeId: string): boolean {
  if (!loaded) {
    loaded = true;
    try {
      const parsed = selectionSchema.safeParse(
        JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'),
      );
      if (parsed.success && Object.keys(parsed.data.sessions).length <= 256) state = parsed.data;
    } catch {
      /* Ignore an unreadable or stale checkpoint. */
    }
  }
  const changed = Boolean(state.runtimeId && state.runtimeId !== runtimeId);
  publish({ type: 'runtime', runtimeId });
  return changed;
}
export function selectTerminal(runtimeId: string, sessionId: string, terminalId?: string): void {
  publish({ type: 'select', runtimeId, sessionId, terminalId });
}
export function useTerminalSelection(
  runtimeId: string | undefined,
  sessionId: string,
): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (state.runtimeId === runtimeId ? state.sessions[sessionId] : undefined),
  );
}
