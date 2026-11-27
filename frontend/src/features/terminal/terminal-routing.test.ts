/**
 * @file 验证终端位置可恢复且不会接受任意子路径。
 * @implementation 直接测试共享路由白名单，避免依赖运行时启动。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isWorkspaceLocation, workspaceSessionId } from '../../../../shared/workspace-location';
import { panelLocation } from '../../app/panels/panel-location';

test('terminal restores its session route without accepting terminal subpaths', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(isWorkspaceLocation(`/sessions/${id}/terminal`), true);
  assert.equal(workspaceSessionId(`/sessions/${id}/terminal`), id);
  assert.equal(isWorkspaceLocation(`/sessions/${id}/terminal/extra`), false);
});

test('tool routes retain their background conversation location and reject another session', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const trace = `/sessions/${sessionId}/trace/22222222-2222-4222-8222-222222222222`;
  assert.equal(
    panelLocation(`/sessions/${sessionId}/terminal`, sessionId, { workspacePanelReturn: trace })
      .contentPath,
    trace,
  );
  assert.equal(
    panelLocation(`/sessions/${sessionId}/browser`, sessionId, { workspaceBrowserReturn: trace })
      .contentPath,
    trace,
  );
  assert.equal(
    panelLocation(`/sessions/${sessionId}/terminal`, sessionId, {
      workspacePanelReturn: '/sessions/33333333-3333-4333-8333-333333333333/trace',
    }).contentPath,
    `/sessions/${sessionId}`,
  );
  assert.equal(
    panelLocation(`/sessions/${sessionId}/terminal`, sessionId, {
      workspacePanelReturn: `/sessions/${sessionId}/browser`,
    }).contentPath,
    `/sessions/${sessionId}`,
  );
});
