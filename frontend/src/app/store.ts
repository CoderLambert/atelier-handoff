/**
 * @file 管理工作区界面与会话交互状态。
 * @implementation 使用 Redux 保存导航、连接状态、草稿、提交状态、临时搜索费用上限和各会话未查看的运行结果。
 * @updated 2026-11-25T19:11:00+08:00
 */
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import type { Draft, RunStatus } from '@shared/types';

export type View = 'chat' | 'artifacts' | 'runs' | 'extensions' | 'agents' | 'settings';
export type Tab = 'conversation' | 'trace' | 'artifacts';
type UnseenRunOutcome = Extract<RunStatus, 'completed' | 'failed' | 'interrupted'>;
interface WorkspaceState {
  drawer?: 'navigation' | 'details';
  connected: boolean;
  drafts: Record<string, Draft>;
  searchChargeLimits: Record<string, string>;
  submitting: Record<string, boolean>;
  unseenRunOutcomes: Record<string, UnseenRunOutcome | undefined>;
}

const initialState: WorkspaceState = {
  connected: false,
  drafts: {},
  searchChargeLimits: {},
  submitting: {},
  unseenRunOutcomes: {},
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
  },
});

export const actions = workspace.actions;
export const store = configureStore({ reducer: { workspace: workspace.reducer } });
export type RootState = ReturnType<typeof store.getState>;
export const useWorkspace = useSelector.withTypes<RootState>();
export const useAppDispatch = useDispatch.withTypes<typeof store.dispatch>();
