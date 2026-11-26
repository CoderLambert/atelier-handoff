/**
 * @file 验证终端启动绑定当前会话的真实目录身份。
 * @implementation 覆盖 linked、in_place 和主目录，并拒绝迟到会话及不可创建状态。
 * @updated 2026-11-26T01:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalWorkspaceTarget } from '../../app/panels/terminal-target';

const session = { id: '11111111-1111-4111-8111-111111111111', status: 'active' as const };
const project = { available: true };
const workspaceId = '22222222-2222-4222-8222-222222222222';

test('terminal creation preserves both linked and in-place workspace identities', () => {
  for (const mode of ['linked', 'in_place'] as const) {
    assert.deepEqual(
      terminalWorkspaceTarget(session.id, {
        session,
        project,
        workspace: { id: workspaceId, mode, state: 'ready' },
      }),
      { expectedWorkspaceId: workspaceId, canCreate: true },
    );
  }
  assert.deepEqual(terminalWorkspaceTarget(session.id, { session, project }), {
    expectedWorkspaceId: null,
    canCreate: true,
  });
});

test('terminal creation waits for the matching active session and available workspace', () => {
  assert.equal(terminalWorkspaceTarget('another-session', { session, project }).canCreate, false);
  assert.equal(terminalWorkspaceTarget(session.id, undefined).canCreate, false);
  assert.equal(
    terminalWorkspaceTarget(session.id, { session: { ...session, status: 'archived' }, project })
      .canCreate,
    false,
  );
  assert.equal(
    terminalWorkspaceTarget(session.id, { session, project: { available: false } }).canCreate,
    false,
  );
  assert.equal(
    terminalWorkspaceTarget(session.id, {
      session,
      project,
      workspace: { id: workspaceId, mode: 'linked', state: 'busy' },
    }).canCreate,
    false,
  );
});
