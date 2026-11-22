/**
 * @file 验证侧栏中的会话分支归组与搜索。
 * @implementation 用固定会话关系检查嵌套、最近活动排序和来源缺失时的回退。
 * @updated 2026-11-21T19:45:00+08:00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@shared/types';
import { buildSessionTree, findSessionPath } from '@/app/session-tree';

function session(id: string, day: number, parent?: string, projectId = 'project'): Session {
  const date = `2026-11-${day}T00:00:00.000Z`;
  return {
    id,
    title: id,
    projectId,
    ...(parent
      ? { fork: { sourceSessionId: parent, sourceMessageId: 'origin', sourceTitle: parent } }
      : {}),
    status: 'active',
    sdkSessionId: null,
    createdAt: date,
    updatedAt: date,
    draft: { text: '', mode: 'readonly', contextPaths: [], attachmentIds: [] },
  };
}

function rewind(id: string, day: number, source: string): Session {
  return {
    ...session(id, day),
    fork: {
      sourceSessionId: source,
      sourceMessageId: 'origin',
      sourceTitle: source,
      kind: 'rewind',
    },
  };
}

const sessions = [
  session('Unrelated', 18),
  session('Parent', 12),
  session('Alternative A', 15, 'Parent'),
  session('Alternative B', 16, 'Parent'),
  session('Variant', 21, 'Alternative A'),
];

test('one root owns all nested branches and gets the newest descendant activity', () => {
  const tree = buildSessionTree(sessions, '');
  assert.deepEqual(
    tree.map((node) => node.session.id),
    ['Parent', 'Unrelated'],
  );
  assert.deepEqual(
    tree[0]?.children.map((node) => node.session.id),
    ['Alternative A', 'Alternative B'],
  );
  assert.deepEqual(findSessionPath(tree, 'Variant'), ['Parent', 'Alternative A', 'Variant']);
});

test('search for a branch retains its path and preserves the full tree after clearing the query', () => {
  const tree = buildSessionTree(sessions, '  VARIANT ');
  assert.equal(tree.length, 1);
  assert.deepEqual(findSessionPath(tree, 'Variant'), ['Parent', 'Alternative A', 'Variant']);
  assert.deepEqual(findSessionPath(tree, 'Alternative B'), []);
  assert.deepEqual(findSessionPath(buildSessionTree(sessions, ''), 'Alternative B'), [
    'Parent',
    'Alternative B',
  ]);
});

test('branches with removed or cross-project parents remain independently reachable', () => {
  const tree = buildSessionTree(
    [
      ...sessions,
      session('Orphan', 19, 'Removed parent'),
      session('Cross-project branch', 20, 'Parent', 'other-project'),
      session('Cycle A', 12, 'Cycle B'),
      session('Cycle B', 12, 'Cycle A'),
    ],
    '',
  );
  assert.deepEqual(findSessionPath(tree, 'Orphan'), ['Orphan']);
  assert.deepEqual(findSessionPath(tree, 'Cross-project branch'), ['Cross-project branch']);
  assert.deepEqual(findSessionPath(tree, 'Cycle B'), ['Cycle A', 'Cycle B']);
});

test('a rewind takes the original tree position and keeps older versions and alternatives reachable', () => {
  const tree = buildSessionTree(
    [
      ...sessions,
      rewind('A restarted', 22, 'Alternative A'),
      rewind('A restarted twice', 23, 'A restarted'),
    ],
    '',
  );
  assert.deepEqual(findSessionPath(tree, 'A restarted twice'), ['Parent', 'A restarted twice']);
  assert.deepEqual(findSessionPath(tree, 'Variant'), [
    'Parent',
    'A restarted twice',
    'A restarted',
    'Alternative A',
    'Variant',
  ]);
  assert.deepEqual(findSessionPath(tree, 'Alternative B'), ['Parent', 'Alternative B']);
  const head = tree[0]?.children.find(({ session }) => session.id === 'A restarted twice');
  assert.equal(head?.priorVersion, false);
  assert.equal(head?.children[0]?.priorVersion, true);
});
