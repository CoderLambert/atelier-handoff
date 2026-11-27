/**
 * @file 管理工作区界面与会话交互状态。
 * @implementation 使用 Redux 保存导航、连接状态、草稿、提交状态、临时搜索费用上限、未查看运行结果以及统一的输入焦点请求信号。
 * @updated 2026-11-27T19:25:00+08:00
 */
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import type { Draft, RunStatus } from '@shared/types';

export type View =
  'chat' | 'artifacts' | 'runs' | 'extensions' | 'agents' | 'schedules' | 'settings';
export type Tab = 'conversation' | 'trace' | 'artifacts';
type UnseenRunOutcome = Extract<RunStatus, 'completed' | 'failed' | 'interrupted'>;

export interface ComposerFocusRequest {
  sessionId: string;
  requestId: number;
  caretToEnd?: boolean;
}

interface WorkspaceState {
  drawer?: 'navigation' | 'details';
  connected: boolean;
  drafts: Record<string, Draft>;
  searchChargeLimits: Record<string, string>;
  submitting: Record<string, boolean>;
  unseenRunOutcomes: Record<string, UnseenRunOutcome | undefined>;
  composerFocus?: ComposerFocusRequest;
  composerFocusSeq: number;
}

const initialState: WorkspaceState = {
  connected: false,
  drafts: {},
  searchChargeLimits: {},
  submitting: {},
  unseenRunOutcomes: {},
  composerFocusSeq: 0,
};
const workspace = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    setDrawer(state, action: PayloadAction<WorkspaceState['drawer']>) {
      state.drawer = action.payload;
    },
    setConnected(state, action: PayloadAction<boolean>) {
      state.connected = action.payload;
    },
    markRunOutcome(state, action: PayloadAction<{ sessionId: string; status: UnseenRunOutcome }>) {
      state.unseenRunOutcomes[action.payload.sessionId] = action.payload.status;
    },
    acknowledgeRunOutcome(state, action: PayloadAction<string>) {
      delete state.unseenRunOutcomes[action.payload];
    },
    setDraft(state, action: PayloadAction<{ id: string; draft: Draft }>) {
      state.drafts[action.payload.id] = action.payload.draft;
    },
    setSearchChargeLimit(state, action: PayloadAction<{ id: string; value?: string }>) {
      if (action.payload.value !== undefined)
        state.searchChargeLimits[action.payload.id] = action.payload.value;
      else delete state.searchChargeLimits[action.payload.id];
    },
    dropDraft(state, action: PayloadAction<string>) {
      delete state.drafts[action.payload];
      delete state.searchChargeLimits[action.payload];
    },
    setSubmitting(state, action: PayloadAction<{ id: string; pending: boolean }>) {
      if (action.payload.pending) state.submitting[action.payload.id] = true;
      else delete state.submitting[action.payload.id];
    },
    requestComposerFocus(
      state,
      action: PayloadAction<{ sessionId: string; caretToEnd?: boolean }>,
    ) {
      const requestId = state.composerFocusSeq + 1;
      state.composerFocusSeq = requestId;
      state.composerFocus = {
        sessionId: action.payload.sessionId,
        requestId,
        ...(action.payload.caretToEnd ? { caretToEnd: true } : {}),
      };
    },
    acknowledgeComposerFocus(state, action: PayloadAction<number>) {
      if (state.composerFocus?.requestId === action.payload) {
        state.composerFocus = undefined;
      }
    },
    clearComposerFocus(state, action: PayloadAction<{ keepSessionId?: string } | undefined>) {
      const keepSessionId = action.payload?.keepSessionId;
      if (!keepSessionId || state.composerFocus?.sessionId !== keepSessionId) {
        state.composerFocus = undefined;
      }
    },
  },
});

export const actions = workspace.actions;
export const workspaceReducer = workspace.reducer;
export function createWorkspaceStore() {
  return configureStore({ reducer: { workspace: workspace.reducer } });
}
export const store = createWorkspaceStore();
export type RootState = ReturnType<typeof store.getState>;
export const useWorkspace = useSelector.withTypes<RootState>();
export const useAppDispatch = useDispatch.withTypes<typeof store.dispatch>();
