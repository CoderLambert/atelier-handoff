/**
 * @file 管理工作区界面与会话交互状态。
 * @implementation 使用 Redux 保存导航、会话草稿、提交状态和各会话的临时搜索费用上限。
 * @updated 2026-11-20T15:58:31+08:00
 */
import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import type { Draft } from '@shared/types';

export type View = 'chat' | 'artifacts' | 'runs' | 'extensions' | 'agents' | 'settings';
export type Tab = 'conversation' | 'trace' | 'artifacts';
interface WorkspaceState {
  drawer?: 'navigation' | 'details';
  connected: boolean;
  drafts: Record<string, Draft>;
  searchChargeLimits: Record<string, string>;
  submitting: Record<string, boolean>;
}

const initialState: WorkspaceState = {
  connected: false,
  drafts: {},
  searchChargeLimits: {},
  submitting: {},
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
