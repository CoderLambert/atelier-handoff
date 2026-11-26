/**
 * @file 验证快捷切换会话的顺序、搜索和可导航资格。
 * @implementation 使用不同项目、归档和创建中的会话检查稳定排序与边界行为。
 * @updated 2026-11-26T20:00:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Session } from '../shared/types.js';
import {
  adjacentSessionId,
  sessionSwitchItems,
} from '../frontend/src/app/session-switcher-model.js';

const project: Project = {
  id: 'project',
  name: 'Atelier',
  path: '/tmp/atelier',
  branch: 'main',
  available: true,
  createdAt: '2026-11-01',
};
function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectId: project.id,
    title: `Conversation ${id}`,
    status: 'active',
    sdkSessionId: null,
    createdAt: '2026-11-01',
    updatedAt: '2026-11-20',
    draft: { text: '', contextPaths: [], attachmentIds: [], mode: 'readonly' },
    ...overrides,
  };
}

test('switcher searches title and project, excludes unfinished forks, and sorts deterministically', () => {
  const sessions = [
    session('b'),
    session('a'),
    session('new', { updatedAt: '2026-11-25' }),
    session('archive', { status: 'archived', updatedAt: '2026-11-26' }),
    session('partial', { creatingFork: true }),
  ];
  assert.deepEqual(
    sessionSwitchItems(sessions, [project], '').map(({ session }) => session.id),
    ['new', 'a', 'b', 'archive'],
  );
  assert.equal(sessionSwitchItems(sessions, [project], 'atelier').length, 4);
  assert.deepEqual(
    sessionSwitchItems(sessions, [project], 'ARCHIVE').map(({ session }) => session.id),
    ['archive'],
  );
  assert.deepEqual(sessionSwitchItems(sessions, [project], 'missing'), []);
  assert.equal(sessions[0]?.id, 'b');
});

test('adjacent commands skip archived/unfinished sessions, wrap, and never select the only current session', () => {
  const sessions = [
    session('old'),
    session('recent', { updatedAt: '2026-11-25' }),
    session('archived', { status: 'archived' }),
    session('partial', { creatingFork: true }),
  ];
  assert.equal(adjacentSessionId(sessions, 'recent', 1), 'old');
  assert.equal(adjacentSessionId(sessions, 'recent', -1), 'old');
  assert.equal(adjacentSessionId(sessions, 'old', 1), 'recent');
  assert.equal(adjacentSessionId(sessions, 'deleted', 1), 'recent');
  assert.equal(adjacentSessionId([session('only')], 'only', 1), undefined);
  assert.equal(adjacentSessionId([], undefined, -1), undefined);
});
