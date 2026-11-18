import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import type { Draft } from '@shared/types';

export type View = 'chat' | 'artifacts' | 'runs' | 'extensions';
export type Tab = 'conversation' | 'trace' | 'artifacts';
interface WorkspaceState {
  view: View;
  tab: Tab;
  sessionId?: string;
  traceRunId?: string;
  drawer?: 'navigation' | 'details';
  connected: boolean;
  drafts: Record<string, Draft>;
  submitting: Record<string, boolean>;
}

const initialState: WorkspaceState = {
  view: 'chat',
  tab: 'conversation',
  connected: false,
  drafts: {},
  submitting: {},
};
const workspace = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    openSession(state, action: PayloadAction<{ id?: string; runId?: string }>) {
      state.sessionId = action.payload.id;
      state.traceRunId = action.payload.runId;
      state.tab = action.payload.runId ? 'trace' : 'conversation';
      state.view = 'chat';
      state.drawer = undefined;
    },
    openView(state, action: PayloadAction<View>) {
      state.view = action.payload;
      state.drawer = undefined;
    },
    setTab(state, action: PayloadAction<Tab>) {
      state.tab = action.payload;
    },
    showTrace(state, action: PayloadAction<string>) {
      state.traceRunId = action.payload;
      state.tab = 'trace';
      state.drawer = undefined;
    },
    setDrawer(state, action: PayloadAction<WorkspaceState['drawer']>) {
      state.drawer = action.payload;
    },
    setConnected(state, action: PayloadAction<boolean>) {
      state.connected = action.payload;
    },
    setDraft(state, action: PayloadAction<{ id: string; draft: Draft }>) {
      state.drafts[action.payload.id] = action.payload.draft;
    },
    dropDraft(state, action: PayloadAction<string>) {
      delete state.drafts[action.payload];
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
