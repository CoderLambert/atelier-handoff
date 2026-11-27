/**
 * @file 验证工作区焦点信号、布局覆盖释放与导航/会话恢复的纯状态流转。
 * @implementation 使用隔离 Redux store 与纯函数测试聚焦请求确认/清理、并发布局覆盖释放、启动路由回退及删除会话落点。
 * @updated 2026-11-27T19:25:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialWorkspaceLayout, type WorkspaceLayout } from '@shared/workspace-layout';
import { actions, createWorkspaceStore } from '@/app/store';
import {
  applyLayoutOverride,
  currentView,
  releaseLayoutOverride,
  resolveInitialWorkspaceRoute,
  resolveWorkspaceLayout,
  selectSessionAfterDelete,
  sessionTab,
  settingsSection,
} from '@/app/workspace-state';

const sessionAId = '11111111-1111-4111-8111-111111111111';
const sessionBId = '22222222-2222-4222-8222-222222222222';
const sessionCId = '33333333-3333-4333-8333-333333333333';

test('Redux composerFocus signal increments requestId, acknowledges exact match, and scopes clear', () => {
  const store = createWorkspaceStore();
  assert.equal(store.getState().workspace.composerFocus, undefined);

  store.dispatch(actions.requestComposerFocus({ sessionId: sessionAId }));
  assert.deepEqual(store.getState().workspace.composerFocus, {
    sessionId: sessionAId,
    requestId: 1,
  });

  store.dispatch(actions.requestComposerFocus({ sessionId: sessionAId, caretToEnd: true }));
  assert.deepEqual(store.getState().workspace.composerFocus, {
    sessionId: sessionAId,
    requestId: 2,
    caretToEnd: true,
  });

  // Acknowledging an outdated request must not clear the latest pending request.
  store.dispatch(actions.acknowledgeComposerFocus(1));
  assert.equal(store.getState().workspace.composerFocus?.requestId, 2);

  // Keeping the same session preserves its pending focus request.
  store.dispatch(actions.clearComposerFocus({ keepSessionId: sessionAId }));
  assert.equal(store.getState().workspace.composerFocus?.requestId, 2);

  // Switching to another session drops the stale request.
  store.dispatch(actions.clearComposerFocus({ keepSessionId: sessionBId }));
  assert.equal(store.getState().workspace.composerFocus, undefined);

  // Sequence remains monotonic after clear and exact acknowledge clears the signal.
  store.dispatch(actions.requestComposerFocus({ sessionId: sessionBId }));
  assert.deepEqual(store.getState().workspace.composerFocus, {
    sessionId: sessionBId,
    requestId: 3,
  });
  store.dispatch(actions.acknowledgeComposerFocus(3));
  assert.equal(store.getState().workspace.composerFocus, undefined);

  // Unconditional clear drops any pending focus request.
  store.dispatch(actions.requestComposerFocus({ sessionId: sessionAId }));
  store.dispatch(actions.clearComposerFocus());
  assert.equal(store.getState().workspace.composerFocus, undefined);
});

test('layout override releases on matching mutation success so subsequent server updates take effect', () => {
  const serverInitial: WorkspaceLayout = {
    defaults: { left: 260, right: 640 },
    recent: { left: 260, right: 640 },
    collapsed: false,
  };
  const optimisticFirst: WorkspaceLayout = {
    ...serverInitial,
    recent: { left: 300, right: 640 },
  };
  const optimisticSecond: WorkspaceLayout = {
    ...serverInitial,
    recent: { left: 320, right: 700 },
    collapsed: true,
  };
  const serverLater: WorkspaceLayout = {
    defaults: { left: 280, right: 660 },
    recent: { left: 280, right: 660 },
    collapsed: false,
  };

  assert.deepEqual(resolveWorkspaceLayout(undefined, undefined), initialWorkspaceLayout);
  assert.deepEqual(resolveWorkspaceLayout(undefined, serverInitial), serverInitial);

  // Rapid consecutive mutations: request 1 then request 2.
  const first = applyLayoutOverride(undefined, optimisticFirst);
  assert.equal(first.requestId, 1);
  assert.deepEqual(resolveWorkspaceLayout(first, serverInitial), optimisticFirst);

  const second = applyLayoutOverride(first, optimisticSecond);
  assert.equal(second.requestId, 2);
  assert.deepEqual(resolveWorkspaceLayout(second, serverInitial), optimisticSecond);

  // When request 1 settles first, request 2's override stays active.
  const afterFirstSuccess = releaseLayoutOverride(second, first.requestId);
  assert.equal(afterFirstSuccess?.requestId, 2);
  assert.deepEqual(resolveWorkspaceLayout(afterFirstSuccess, optimisticFirst), optimisticSecond);

  // When request 2 succeeds, override releases and subsequent server updates are no longer shadowed.
  const afterSecondSuccess = releaseLayoutOverride(afterFirstSuccess, second.requestId);
  assert.equal(afterSecondSuccess, undefined);
  assert.deepEqual(resolveWorkspaceLayout(afterSecondSuccess, optimisticSecond), optimisticSecond);
  assert.deepEqual(resolveWorkspaceLayout(afterSecondSuccess, serverLater), serverLater);
});

test('resolveInitialWorkspaceRoute restores valid saved paths and falls back cleanly on stale sessions', () => {
  const sessions = [
    { id: sessionAId, status: 'archived' as const },
    { id: sessionBId, status: 'active' as const },
  ];

  // Valid saved workspace location pointing to an existing session.
  assert.deepEqual(
    resolveInitialWorkspaceRoute({
      workspaceLocation: `/sessions/${sessionBId}/trace`,
      sessions,
      projects: [{ id: 'p1' }],
    }),
    { kind: 'replace-raw', path: `/sessions/${sessionBId}/trace` },
  );

  // Valid non-session workspace location (e.g. settings).
  assert.deepEqual(
    resolveInitialWorkspaceRoute({
      workspaceLocation: '/settings/shortcuts',
      sessions,
      projects: [{ id: 'p1' }],
    }),
    { kind: 'replace-raw', path: '/settings/shortcuts' },
  );

  // Stale saved session falls back to workspaceLastSession, then remembered local session, then active.
  assert.deepEqual(
    resolveInitialWorkspaceRoute(
      {
        workspaceLocation: `/sessions/${sessionCId}`,
        workspaceLastSession: sessionAId,
        sessions,
        projects: [{ id: 'p1' }],
      },
      sessionBId,
    ),
    { kind: 'session', sessionId: sessionAId, openProjects: false },
  );

  assert.deepEqual(
    resolveInitialWorkspaceRoute(
      {
        workspaceLocation: `/sessions/${sessionCId}`,
        sessions,
        projects: [{ id: 'p1' }],
      },
      sessionBId,
    ),
    { kind: 'session', sessionId: sessionBId, openProjects: false },
  );

  // Empty workspace opens projects dialog.
  assert.deepEqual(
    resolveInitialWorkspaceRoute({
      workspaceLocation: undefined,
      sessions: [],
      projects: [],
    }),
    { kind: 'sessions', openProjects: true },
  );
});

test('selectSessionAfterDelete prefers an active session in the same project before falling back', () => {
  const sessions = [
    { id: sessionAId, projectId: 'proj-1', status: 'active' as const },
    { id: sessionBId, projectId: 'proj-2', status: 'active' as const },
    { id: sessionCId, projectId: 'proj-1', status: 'active' as const },
  ];

  assert.equal(
    selectSessionAfterDelete(sessions, { id: sessionAId, projectId: 'proj-1' }),
    sessionCId,
  );
  assert.equal(
    selectSessionAfterDelete(
      [
        { id: sessionAId, projectId: 'proj-1', status: 'active' },
        { id: sessionBId, projectId: 'proj-2', status: 'active' },
        { id: sessionCId, projectId: 'proj-1', status: 'archived' },
      ],
      { id: sessionAId, projectId: 'proj-1' },
    ),
    sessionBId,
  );
  assert.equal(
    selectSessionAfterDelete([{ id: sessionAId, projectId: 'proj-1', status: 'active' }], {
      id: sessionAId,
      projectId: 'proj-1',
    }),
    undefined,
  );
});

test('route view, tab, and settings section helpers classify paths deterministically', () => {
  assert.equal(currentView('/settings/layout'), 'settings');
  assert.equal(currentView('/extensions'), 'extensions');
  assert.equal(currentView('/runs'), 'runs');
  assert.equal(currentView(`/sessions/${sessionAId}`), 'chat');

  assert.equal(sessionTab(`/sessions/${sessionAId}/trace`, sessionAId), 'trace');
  assert.equal(sessionTab(`/sessions/${sessionAId}/artifacts`, sessionAId), 'artifacts');
  assert.equal(sessionTab('/artifacts', undefined), 'conversation');
  assert.equal(sessionTab(`/sessions/${sessionAId}`, sessionAId), 'conversation');

  assert.equal(settingsSection('/settings/layout'), 'layout');
  assert.equal(settingsSection('/settings/shortcuts'), 'shortcuts');
  assert.equal(settingsSection('/settings/notifications'), 'notifications');
  assert.equal(settingsSection('/settings/diagnostics'), 'diagnostics');
  assert.equal(settingsSection('/settings/models'), 'models');
});
